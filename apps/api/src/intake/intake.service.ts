import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  intakeContext,
  type GuestIdentity,
  type IntakeContext,
  type TripBriefProps,
} from '@travel-agent/shared';
import { MemoryIntakeStore } from './intake.memory-store.js';
import {
  INTAKE_STORE,
  type IntakeRecord,
  type IntakeStore,
} from './intake.store.js';

export type { IntakeRecord } from './intake.store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_CONVERSATIONS = 10_000;

const hash = (key: string) => createHash('sha256').update(key).digest();

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  logger: Logger,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1) return value;
  logger.warn(`${name}="${raw}" is not a whole number >= 1; using ${fallback}`);
  return fallback;
}

/**
 * The guest-entered and guest-confirmed intake details, keyed by chat
 * conversation id. This is the source of truth the agents read back from.
 *
 * The browser that first stores an identity for a conversation id gets a key
 * for it; every later write, and every chat turn, must present that key.
 *
 * Records are deleted after INTAKE_RETENTION_DAYS (default 7) with no activity
 * (a write, or a chat turn), and the oldest beyond INTAKE_MAX_CONVERSATIONS.
 */
@Injectable()
export class IntakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Intake');
  private readonly retentionDays: number;
  private readonly maxConversations: number;
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    @Inject(INTAKE_STORE)
    private readonly store: IntakeStore = new MemoryIntakeStore(),
    @Optional() config?: ConfigService,
  ) {
    this.retentionDays = positiveInt(
      config?.get<string>('INTAKE_RETENTION_DAYS'),
      DEFAULT_RETENTION_DAYS,
      'INTAKE_RETENTION_DAYS',
      this.logger,
    );
    this.maxConversations = positiveInt(
      config?.get<string>('INTAKE_MAX_CONVERSATIONS'),
      DEFAULT_MAX_CONVERSATIONS,
      'INTAKE_MAX_CONVERSATIONS',
      this.logger,
    );
  }

  async onModuleInit() {
    await this.prune();
    this.pruneTimer = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.pruneTimer);
  }

  /**
   * Stores the guest's identity. On a new conversation this claims it and
   * returns the key; on an existing one the key must match.
   */
  async setIdentity(
    conversationId: string,
    identity: GuestIdentity,
    key: string | undefined,
  ): Promise<{ conversationKey?: string }> {
    if (!(await this.store.get(conversationId))) {
      const conversationKey = randomBytes(32).toString('base64url');
      const claimed = await this.store.claim(conversationId, {
        keyHash: hash(conversationKey),
        threadId: randomBytes(16).toString('base64url'),
        identity,
      });
      if (claimed) return { conversationKey };
      // Another browser claimed it first: from here on it's theirs.
    }
    await this.authorize(conversationId, key);
    await this.store.update(conversationId, { identity });
    return {};
  }

  async confirmTrip(
    conversationId: string,
    trip: TripBriefProps,
    key: string | undefined,
  ): Promise<IntakeContext> {
    const record = await this.authorize(conversationId, key);
    await this.store.update(conversationId, { trip });
    return intakeContext(record.identity, trip);
  }

  /**
   * Stores an unconfirmed brief. The caller must already be authorized (by
   * conversation key or the intake token); the conversation must exist.
   */
  async saveDraft(
    conversationId: string,
    draft: TripBriefProps,
  ): Promise<IntakeContext> {
    const record = await this.store.get(conversationId);
    if (!record) throw new NotFoundException('Unknown conversation');
    await this.store.update(conversationId, { draft });
    return intakeContext(record.identity, record.trip, draft);
  }

  /** Throws unless `key` is the one issued for this conversation; counts as activity. */
  async authorize(
    conversationId: string,
    key: string | undefined,
  ): Promise<IntakeRecord> {
    const record = await this.store.get(conversationId);
    if (!record) throw new NotFoundException('Unknown conversation');
    if (!key || !timingSafeEqual(hash(key), record.keyHash))
      throw new ForbiddenException();
    await this.store.touch(conversationId);
    return record;
  }

  async context(conversationId: string): Promise<IntakeContext> {
    const record = await this.store.get(conversationId);
    return intakeContext(record?.identity, record?.trip, record?.draft);
  }

  /** This claim's Parlant session, if one was stored; see ParlantService. */
  setParlantSession(conversationId: string, sessionId: string) {
    return this.store.setParlantSession(conversationId, sessionId);
  }

  clearParlantSession(conversationId: string) {
    return this.store.clearParlantSession(conversationId);
  }

  /** Deletes expired and excess records. Never throws: it runs on a timer. */
  async prune(now = Date.now()): Promise<number> {
    try {
      const count = await this.store.prune(
        new Date(now - this.retentionDays * DAY_MS),
        this.maxConversations,
      );
      if (count > 0) this.logger.log(`intake pruned count=${count}`);
      return count;
    } catch (err) {
      this.logger.error(
        `intake prune failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
