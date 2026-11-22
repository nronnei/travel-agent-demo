import { Logger } from '@nestjs/common';
import { GuestIdentitySchema, TripBriefPropsSchema } from '@travel-agent/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../database/database.module.js';
import { conversations } from '../database/schema/index.js';
import {
  TOUCH_INTERVAL_MS,
  type IntakePatch,
  type IntakeRecord,
  type IntakeStore,
} from './intake.store.js';

/** The row cap is enforced on claim at most this often (and on every prune). */
const CAP_CHECK_INTERVAL_MS = 60 * 1000;

/** Intake records in the API database's `intake.conversations`. */
export class PostgresIntakeStore implements IntakeStore {
  private readonly logger = new Logger('Intake');
  private lastCapCheck = 0;

  constructor(
    private readonly db: Database,
    private readonly maxRecords = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(conversationId: string): Promise<IntakeRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId))
      .limit(1);
    if (!row) return undefined;
    // Stored JSON is re-validated: a row in an older shape reads as absent
    // (logged by id only: the values are the guest's details).
    const identity = GuestIdentitySchema.safeParse(row.identity);
    const trip = row.trip == null ? undefined : TripBriefPropsSchema.safeParse(row.trip);
    const draft = row.draft == null ? undefined : TripBriefPropsSchema.safeParse(row.draft);
    if (!identity.success || trip?.success === false || draft?.success === false) {
      this.logger.warn(`intake record failed validation conversation=${conversationId}`);
      return undefined;
    }
    return {
      keyHash: row.keyHash,
      threadId: row.threadId,
      ...(row.parlantSessionId ? { parlantSessionId: row.parlantSessionId } : {}),
      identity: identity.data,
      ...(trip ? { trip: trip.data } : {}),
      ...(draft ? { draft: draft.data } : {}),
    };
  }

  async claim(conversationId: string, record: IntakeRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(conversations)
      .values({
        conversationId,
        keyHash: record.keyHash,
        threadId: record.threadId,
        identity: record.identity,
        trip: record.trip,
        draft: record.draft,
      })
      .onConflictDoNothing({ target: conversations.conversationId })
      .returning({ id: conversations.conversationId });
    if (inserted.length === 0) return false;
    // Bounds the table between hourly prunes, so a flood of claims can't fill the volume.
    if (this.now() - this.lastCapCheck >= CAP_CHECK_INTERVAL_MS) {
      this.lastCapCheck = this.now();
      await this.deleteBeyond(this.maxRecords);
    }
    return true;
  }

  async update(conversationId: string, patch: IntakePatch): Promise<void> {
    await this.db
      .update(conversations)
      .set({ ...patch, updatedAt: sql`now()`, lastSeenAt: sql`now()` })
      .where(eq(conversations.conversationId, conversationId));
  }

  async touch(conversationId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(conversations.conversationId, conversationId),
          lt(
            conversations.lastSeenAt,
            sql`now() - make_interval(secs => ${TOUCH_INTERVAL_MS / 1000})`,
          ),
        ),
      );
  }

  async setParlantSession(
    conversationId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    await this.db
      .update(conversations)
      .set({ parlantSessionId: sessionId })
      .where(
        and(
          eq(conversations.conversationId, conversationId),
          isNull(conversations.parlantSessionId),
        ),
      );
    const [row] = await this.db
      .select({ session: conversations.parlantSessionId })
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId));
    return row?.session ?? undefined;
  }

  async clearParlantSession(conversationId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ parlantSessionId: null })
      .where(eq(conversations.conversationId, conversationId));
  }

  async prune(before: Date, max: number): Promise<number> {
    const expired = await this.db
      .delete(conversations)
      .where(lt(conversations.lastSeenAt, before))
      .returning({ id: conversations.conversationId });
    return expired.length + (await this.deleteBeyond(max));
  }

  /** Deletes the least recently active records beyond `max`. */
  private async deleteBeyond(max: number): Promise<number> {
    const excess = this.db
      .select({ id: conversations.conversationId })
      .from(conversations)
      .orderBy(desc(conversations.lastSeenAt))
      .offset(max);
    const deleted = await this.db
      .delete(conversations)
      .where(inArray(conversations.conversationId, excess))
      .returning({ id: conversations.conversationId });
    return deleted.length;
  }
}
