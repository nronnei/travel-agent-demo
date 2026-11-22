import type {
  GuestIdentity,
  TripBriefProps,
} from '@travel-agent/shared';

export interface IntakeRecord {
  /** SHA-256 of the conversation key handed to the browser that claimed it. */
  keyHash: Buffer;
  /**
   * The LangGraph thread for this claim, minted with it. Conversation ids are
   * chosen by the browser and can be claimed again once this record is gone
   * (retention, eviction), while LangGraph's checkpoints outlive it; a fresh
   * thread per claim keeps a reclaimed id from reading an earlier guest's thread.
   */
  threadId: string;
  /** This claim's Parlant session, for the same reason as threadId. */
  parlantSessionId?: string;
  identity: GuestIdentity;
  /** Set only once the guest confirms the brief. */
  trip?: TripBriefProps;
  /**
   * The latest unconfirmed brief, written by the Parlant and LangGraph agents
   * when they show one and by the app when the guest edits it. Inkeep never sets it.
   */
  draft?: TripBriefProps;
}

export type IntakePatch = Partial<
  Pick<IntakeRecord, 'identity' | 'trip' | 'draft'>
>;

/** Where intake records live: Postgres in the cluster, memory without DATABASE_URL. */
export interface IntakeStore {
  get(conversationId: string): Promise<IntakeRecord | undefined>;
  /** Inserts only if absent; false when the id was already claimed. */
  claim(conversationId: string, record: IntakeRecord): Promise<boolean>;
  /** Applies the patch and counts as activity. */
  update(conversationId: string, patch: IntakePatch): Promise<void>;
  /** Counts as activity, at most once an hour per record. */
  touch(conversationId: string): Promise<void>;
  /**
   * Sets the Parlant session unless one is set; returns the session that won,
   * or undefined if the record is gone.
   */
  setParlantSession(
    conversationId: string,
    sessionId: string,
  ): Promise<string | undefined>;
  /** Clears the Parlant session, so the next turn starts a new one. */
  clearParlantSession(conversationId: string): Promise<void>;
  /**
   * Deletes records with no activity since `before`, then the least recently
   * active beyond `max`. Returns how many were deleted.
   */
  prune(before: Date, max: number): Promise<number>;
}

export const INTAKE_STORE = Symbol('INTAKE_STORE');

/** Activity bumps from chat turns are throttled to this. */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
