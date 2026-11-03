import { Injectable } from '@nestjs/common';
import {
  intakeContext,
  type GuestIdentity,
  type IntakeContext,
  type TripBriefProps,
} from '@travel-agent/shared';

interface IntakeRecord {
  identity?: GuestIdentity;
  /** Set only once the guest confirms the brief. */
  trip?: TripBriefProps;
}

/** Oldest conversations are evicted beyond this, so the in-memory store stays bounded. */
const MAX_CONVERSATIONS = 10_000;

/**
 * The guest-entered and guest-confirmed intake details, keyed by chat
 * conversation id. This is the source of truth the agents read back from.
 *
 * In memory for now: it is lost on restart and not shared across API replicas.
 */
@Injectable()
export class IntakeService {
  private readonly records = new Map<string, IntakeRecord>();

  setIdentity(conversationId: string, identity: GuestIdentity): IntakeContext {
    return this.update(conversationId, { identity });
  }

  confirmTrip(conversationId: string, trip: TripBriefProps): IntakeContext {
    return this.update(conversationId, { trip });
  }

  context(conversationId: string): IntakeContext {
    const record = this.records.get(conversationId);
    return intakeContext(record?.identity, record?.trip);
  }

  private update(conversationId: string, patch: IntakeRecord): IntakeContext {
    const record = { ...this.records.get(conversationId), ...patch };
    // Re-insert so Map order tracks recency for eviction.
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    if (this.records.size > MAX_CONVERSATIONS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return intakeContext(record.identity, record.trip);
  }
}
