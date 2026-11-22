import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  intakeContext,
  type GuestIdentity,
  type IntakeContext,
  type TripBriefProps,
} from '@travel-agent/shared';

export interface IntakeRecord {
  /** SHA-256 of the conversation key handed to the browser that claimed it. */
  keyHash: Buffer;
  /**
   * The LangGraph thread for this claim, minted with it. Conversation ids are
   * chosen by the browser and can be claimed again once this record is gone
   * (restart, eviction), while LangGraph's checkpoints outlive it; a fresh
   * thread per claim keeps a reclaimed id from reading an earlier guest's thread.
   */
  threadId: string;
  identity: GuestIdentity;
  /** Set only once the guest confirms the brief. */
  trip?: TripBriefProps;
  /**
   * The latest unconfirmed brief, written by the Parlant and LangGraph agents
   * when they show one and by the app when the guest edits it. Inkeep never sets it.
   */
  draft?: TripBriefProps;
}

/** Oldest conversations are evicted beyond this, so the in-memory store stays bounded. */
const MAX_CONVERSATIONS = 10_000;

const hash = (key: string) => createHash('sha256').update(key).digest();

/**
 * The guest-entered and guest-confirmed intake details, keyed by chat
 * conversation id. This is the source of truth the agents read back from.
 *
 * The browser that first stores an identity for a conversation id gets a key
 * for it; every later write, and every chat turn, must present that key.
 *
 * In memory for now: it is lost on restart and not shared across API replicas.
 */
@Injectable()
export class IntakeService {
  private readonly records = new Map<string, IntakeRecord>();

  /**
   * Stores the guest's identity. On a new conversation this claims it and
   * returns the key; on an existing one the key must match.
   */
  setIdentity(
    conversationId: string,
    identity: GuestIdentity,
    key: string | undefined,
  ): { conversationKey?: string } {
    const existing = this.records.get(conversationId);
    if (existing) {
      this.authorize(conversationId, key);
      this.store(conversationId, { ...existing, identity });
      return {};
    }
    const conversationKey = randomBytes(32).toString('base64url');
    this.store(conversationId, {
      keyHash: hash(conversationKey),
      threadId: randomBytes(16).toString('base64url'),
      identity,
    });
    return { conversationKey };
  }

  confirmTrip(
    conversationId: string,
    trip: TripBriefProps,
    key: string | undefined,
  ): IntakeContext {
    const record = this.authorize(conversationId, key);
    this.store(conversationId, { ...record, trip });
    return intakeContext(record.identity, trip);
  }

  /**
   * Stores an unconfirmed brief. The caller must already be authorized (by
   * conversation key or the intake token); the conversation must exist.
   */
  saveDraft(conversationId: string, draft: TripBriefProps): IntakeContext {
    const record = this.records.get(conversationId);
    if (!record) throw new NotFoundException('Unknown conversation');
    this.store(conversationId, { ...record, draft });
    return intakeContext(record.identity, record.trip, draft);
  }

  /** Throws unless `key` is the one issued for this conversation. */
  authorize(conversationId: string, key: string | undefined): IntakeRecord {
    const record = this.records.get(conversationId);
    if (!record) throw new NotFoundException('Unknown conversation');
    if (!key || !timingSafeEqual(hash(key), record.keyHash))
      throw new ForbiddenException();
    return record;
  }

  context(conversationId: string): IntakeContext {
    const record = this.records.get(conversationId);
    return intakeContext(record?.identity, record?.trip, record?.draft);
  }

  private store(conversationId: string, record: IntakeRecord) {
    // Re-insert so Map order tracks recency for eviction.
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    if (this.records.size > MAX_CONVERSATIONS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
  }
}
