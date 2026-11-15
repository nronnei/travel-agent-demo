import { Injectable } from '@nestjs/common';
import { ParlantClient } from './parlant.client.js';

/** Oldest conversations are evicted beyond this, like the intake store. */
const MAX_SESSIONS = 10_000;

/**
 * Maps chat conversations to Parlant sessions. Each conversation is also its
 * own Parlant customer, with the conversation id as the customer id, so the
 * agent's tools can find the guest's intake record from the customer.
 *
 * In memory, like the intake store: a restart starts new Parlant sessions.
 */
@Injectable()
export class ParlantService {
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(private readonly client: ParlantClient) {}

  /** The conversation's Parlant session, created on first use. */
  sessionFor(conversationId: string): Promise<string> {
    let session = this.sessions.get(conversationId);
    if (!session) {
      session = this.create(conversationId);
      // Forget failures so the next request retries.
      session.catch(() => this.sessions.delete(conversationId));
      this.sessions.set(conversationId, session);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    return session;
  }

  /** Drops a session Parlant no longer has, so it isn't used again. */
  forget(conversationId: string): void {
    this.sessions.delete(conversationId);
  }

  private async create(conversationId: string): Promise<string> {
    await this.client.ensureCustomer(conversationId);
    return this.client.createSession(conversationId);
  }
}
