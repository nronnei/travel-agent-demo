import {
  IntakeContextSchema,
  IntakeHeader,
  SEARCH_CLIENT_HEADER,
  WebSearchResponseSchema,
  type IntakeContext,
  type TripBriefProps,
  type WebSearchResponse,
} from '@travel-agent/shared';

const SEARCH_TIMEOUT_MS = 15_000;
const INTAKE_TIMEOUT_MS = 10_000;

/** The guest's intake record in the Nest API, read and written with the shared intake token. */
export class IntakeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async context(conversationId: string): Promise<IntakeContext> {
    const res = await this.fetchFn(this.url(conversationId, 'context'), {
      headers: { [IntakeHeader.Token]: this.token },
      signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Intake context failed (${res.status})`);
    return IntakeContextSchema.parse(await res.json());
  }

  /** Saves the brief the agent showed as the unconfirmed draft. Idempotent. */
  async saveDraft(
    conversationId: string,
    brief: TripBriefProps,
  ): Promise<void> {
    const res = await this.fetchFn(this.url(conversationId, 'draft'), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [IntakeHeader.Token]: this.token,
      },
      body: JSON.stringify(brief),
      signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Intake draft failed (${res.status})`);
  }

  private url(conversationId: string, path: string): URL {
    return new URL(
      `/api/intake/${encodeURIComponent(conversationId)}/${path}`,
      this.baseUrl,
    );
  }
}

export interface SearchArgs {
  query: string;
  maxResults: number;
  recencyDays?: number;
}

/** Web search through the Nest API, which holds the provider key. */
export class SearchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async search(args: SearchArgs): Promise<WebSearchResponse> {
    if (!this.token) throw new Error('SEARCH_API_TOKEN is not set');
    const res = await this.fetchFn(new URL('/api/search/web', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        [SEARCH_CLIENT_HEADER]: 'langgraph',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    return WebSearchResponseSchema.parse(await res.json());
  }
}
