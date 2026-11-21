import {
  BadGatewayException,
  GoneException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shown when Parlant no longer has a conversation's session (e.g. it restarted
 * without persistent storage). The conversation can't continue there.
 */
export const SESSION_GONE_MESSAGE =
  'This conversation has ended. Start a new chat to carry on.';

/** A path under one Parlant session: its events, or the session itself. */
const SESSION_PATH = /^\/sessions\/[^/?]+/;

/** Parlant's REST API, as used here. Shapes are from Parlant 4.0.5's source. */
export interface ParlantEvent {
  id: string;
  offset: number;
  kind: 'message' | 'tool' | 'status' | 'custom';
  source: string;
  trace_id: string;
  data: unknown;
}

/** Query for an event stream: events from `minOffset`, or after the SSE `lastEventId`. */
export interface EventsQuery {
  minOffset?: number;
  lastEventId?: string;
}

/**
 * A small client for the Parlant server. It runs only in-cluster, under
 * Parlant's development authorization policy, so requests carry no credentials;
 * the API in front of it checks conversation ownership.
 */
@Injectable()
export class ParlantClient {
  private readonly logger = new Logger(ParlantClient.name);

  constructor(private readonly config: ConfigService) {}

  get agentId(): string {
    return this.config.get('PARLANT_AGENT_ID', 'travel-agent');
  }

  /**
   * Creates the customer unless it exists. Parlant answers a duplicate id with a
   * 500 rather than a 409, so check first, and re-check after a failed create
   * in case a concurrent request made it.
   */
  async ensureCustomer(id: string): Promise<void> {
    const path = `/customers/${encodeURIComponent(id)}`;
    if ((await this.request(path, { allow: [404] })).ok) return;
    const created = await this.request('/customers', {
      method: 'POST',
      body: { id, name: id },
      allow: [500],
    });
    if (!created.ok) await this.request(path);
  }

  async createSession(customerId: string): Promise<string> {
    const res = await this.request('/sessions', {
      method: 'POST',
      body: { agent_id: this.agentId, customer_id: customerId },
    });
    return ((await res.json()) as { id: string }).id;
  }

  /** Posts a guest message, which starts the agent's turn. */
  async postMessage(sessionId: string, message: string): Promise<ParlantEvent> {
    const res = await this.request(`/sessions/${sessionId}/events`, {
      method: 'POST',
      body: { kind: 'message', source: 'customer', message },
    });
    return (await res.json()) as ParlantEvent;
  }

  /** Cancels the turn in progress. A 409 means none was running, which is fine. */
  async cancel(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/events`, {
      method: 'POST',
      body: { kind: 'status', source: 'customer', status: 'cancelled' },
      allow: [409, 504],
    });
  }

  /**
   * The session's events as Parlant's SSE stream (`id: <offset>`, `data: <event>`).
   * Each event is sent once, when it first appears, and the stream closes after
   * `wait_for_data` idle seconds; clients reconnect with Last-Event-ID.
   */
  events(sessionId: string, query: EventsQuery, signal: AbortSignal) {
    const params = new URLSearchParams({ sse: 'true', wait_for_data: '60' });
    if (query.minOffset !== undefined)
      params.set('min_offset', String(query.minOffset));
    return this.request(`/sessions/${sessionId}/events?${params}`, {
      signal,
      headers: query.lastEventId ? { 'last-event-id': query.lastEventId } : {},
    });
  }

  /**
   * One event as SSE, re-sent each time it grows: how a streamed agent message
   * is followed until its `data.chunks` ends in null.
   */
  event(sessionId: string, eventId: string, signal: AbortSignal) {
    const params = new URLSearchParams({ sse: 'true', wait_for_data: '60' });
    return this.request(
      `/sessions/${sessionId}/events/${encodeURIComponent(eventId)}?${params}`,
      { signal },
    );
  }

  private async request(
    path: string,
    {
      method = 'GET',
      body,
      headers = {},
      signal,
      allow = [],
    }: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      /** Error statuses the caller handles itself. */
      allow?: number[];
    } = {},
  ): Promise<Response> {
    const baseUrl = this.config.get<string>('PARLANT_API_URL');
    if (!baseUrl)
      throw new ServiceUnavailableException('Chat is not configured');
    const res = await fetch(new URL(path, baseUrl), {
      method,
      signal,
      headers: {
        ...headers,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: unknown) => {
      if (signal?.aborted) throw err;
      this.logger.error(`Parlant unreachable: ${String(err)}`);
      throw new BadGatewayException('Agent service unreachable');
    });
    if (!res.ok && !allow.includes(res.status)) {
      const detail = await res.text().catch(() => '');
      if (res.status === 404 && SESSION_PATH.test(path)) {
        this.logger.warn(`Parlant session gone: ${method} ${path}: ${detail}`);
        throw new GoneException(SESSION_GONE_MESSAGE);
      }
      this.logger.error(`Parlant ${method} ${path} → ${res.status}: ${detail}`);
      throw new BadGatewayException(`Agent service error (${res.status})`);
    }
    return res;
  }
}
