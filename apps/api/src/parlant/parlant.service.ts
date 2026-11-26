import { Injectable } from '@nestjs/common';
import { IntakeService, type IntakeRecord } from '../intake/intake.service.js';
import { ParlantClient } from './parlant.client.js';

/**
 * Maps chat conversations to Parlant sessions. Each conversation is also its
 * own Parlant customer, with the conversation id as the customer id, so the
 * agent's tools can find the guest's intake record from the customer (the
 * customer holds nothing else: its name is the id).
 *
 * The session belongs to the claim, not the id: it's stored on the intake
 * record, so it survives API restarts and is deleted with the record. A
 * conversation id reclaimed after retention gets a new session, never the
 * previous guest's.
 */
@Injectable()
export class ParlantService {
  /** In-flight creations, by claim, so concurrent first turns share one session. */
  private readonly creating = new Map<string, Promise<string>>();

  constructor(
    private readonly client: ParlantClient,
    private readonly intake: IntakeService,
  ) {}

  /** The claim's Parlant session, created on first use. */
  sessionFor(conversationId: string, record: IntakeRecord): Promise<string> {
    if (record.parlantSessionId) return Promise.resolve(record.parlantSessionId);
    let session = this.creating.get(record.threadId);
    if (!session) {
      session = this.create(conversationId).finally(() =>
        this.creating.delete(record.threadId),
      );
      this.creating.set(record.threadId, session);
    }
    return session;
  }

  /** Drops a session Parlant no longer has, so the next turn starts a new one. */
  forget(conversationId: string): Promise<void> {
    return this.intake.clearParlantSession(conversationId);
  }

  private async create(conversationId: string): Promise<string> {
    await this.client.ensureCustomer(conversationId);
    const created = await this.client.createSession(conversationId);
    // Another API replica may have stored one first; use the stored one.
    return (await this.intake.setParlantSession(conversationId, created)) ?? created;
  }
}
