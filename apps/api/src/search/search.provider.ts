import { ServiceUnavailableException } from '@nestjs/common';
import type { WebSearchRequest, WebSearchResult } from '@travel-agent/shared';

/** A validated request: defaults applied, `recencyDays` still optional. */
export type ProviderRequest = Required<Omit<WebSearchRequest, 'recencyDays'>> &
  Pick<WebSearchRequest, 'recencyDays'> & {
    /** Usage-grouping label at the provider (Tavily `X-Project-ID`). */
    projectId?: string;
  };

/** What a provider returns: the results, plus the credits billed if it says. */
export interface ProviderResult {
  results: WebSearchResult[];
  /** Provider-reported cost of this call. Absent when the provider doesn't say. */
  credits?: number;
}

/** A web search backend. Switching providers is one new implementation. */
export interface SearchProvider {
  /** `false` for the `off` provider: the service rejects before counting limits. */
  readonly enabled: boolean;
  search(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResult>;
}

/** Injection token for the configured provider. Specs override it with a stub. */
export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');

export const SearchProviderNames = ['tavily', 'off'] as const;
export type SearchProviderName = (typeof SearchProviderNames)[number];

/**
 * A provider failure. Carries only the upstream HTTP status (or `timeout` /
 * `network`): never the response body, request headers or query, so nothing
 * sensitive reaches logs or the agent.
 */
export class ProviderError extends Error {
  constructor(readonly status: number | 'timeout' | 'network') {
    super(`Search provider error (${status})`);
    this.name = 'ProviderError';
  }
}

export const offProvider: SearchProvider = {
  enabled: false,
  search() {
    return Promise.reject(
      new ServiceUnavailableException('Web search is turned off'),
    );
  },
};
