import {
  TOUCH_INTERVAL_MS,
  type IntakePatch,
  type IntakeRecord,
  type IntakeStore,
} from './intake.store.js';

interface Entry {
  record: IntakeRecord;
  lastSeenAt: number;
}

/**
 * Intake records in a Map, for running without DATABASE_URL: lost on restart
 * and not shared across API replicas. Bounded like the Postgres store.
 */
export class MemoryIntakeStore implements IntakeStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxRecords = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(conversationId: string): Promise<IntakeRecord | undefined> {
    return Promise.resolve(this.entries.get(conversationId)?.record);
  }

  claim(conversationId: string, record: IntakeRecord): Promise<boolean> {
    if (this.entries.has(conversationId)) return Promise.resolve(false);
    this.entries.set(conversationId, { record, lastSeenAt: this.now() });
    this.evictBeyond(this.maxRecords);
    return Promise.resolve(true);
  }

  update(conversationId: string, patch: IntakePatch): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (entry) this.put(conversationId, { ...entry.record, ...patch });
    return Promise.resolve();
  }

  touch(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (entry && this.now() - entry.lastSeenAt >= TOUCH_INTERVAL_MS)
      this.put(conversationId, entry.record);
    return Promise.resolve();
  }

  setParlantSession(
    conversationId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const entry = this.entries.get(conversationId);
    if (!entry) return Promise.resolve(undefined);
    if (!entry.record.parlantSessionId)
      entry.record = { ...entry.record, parlantSessionId: sessionId };
    return Promise.resolve(entry.record.parlantSessionId);
  }

  clearParlantSession(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (entry) {
      const { parlantSessionId: _, ...rest } = entry.record;
      entry.record = rest;
    }
    return Promise.resolve();
  }

  prune(before: Date, max: number): Promise<number> {
    let deleted = 0;
    for (const [id, entry] of this.entries)
      if (entry.lastSeenAt < before.getTime()) {
        this.entries.delete(id);
        deleted++;
      }
    return Promise.resolve(deleted + this.evictBeyond(max));
  }

  /** Re-inserts so Map order tracks recency. */
  private put(conversationId: string, record: IntakeRecord) {
    this.entries.delete(conversationId);
    this.entries.set(conversationId, { record, lastSeenAt: this.now() });
  }

  private evictBeyond(max: number): number {
    let deleted = 0;
    for (const id of this.entries.keys()) {
      if (this.entries.size <= max) break;
      this.entries.delete(id);
      deleted++;
    }
    return deleted;
  }
}
