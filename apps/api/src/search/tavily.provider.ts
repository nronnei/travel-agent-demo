import { SNIPPET_MAX_CHARS, type WebSearchResult } from '@travel-agent/shared';
import {
  ProviderError,
  type ProviderRequest,
  type SearchProvider,
} from './search.provider.js';

export const TAVILY_URL = 'https://api.tavily.com/search';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
}

/**
 * Tavily's search API (https://docs.tavily.com/api-reference/endpoint/search).
 * Recency uses `start_date`, which filters general (not only news) search by
 * publish date; `include_published_date` asks for a date on each result.
 */
export class TavilyProvider implements SearchProvider {
  readonly enabled = true;

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  requestBody(req: ProviderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query: req.query,
      max_results: req.maxResults,
      search_depth: 'basic',
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
    };
    if (req.recencyDays !== undefined) {
      const since = new Date(this.now().getTime() - req.recencyDays * DAY_MS);
      body.start_date = since.toISOString().slice(0, 10);
    }
    return body;
  }

  async search(
    req: ProviderRequest,
    signal: AbortSignal,
  ): Promise<WebSearchResult[]> {
    let res: Response;
    try {
      res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(this.requestBody(req)),
        signal,
      });
    } catch (err) {
      throw new ProviderError(
        err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timeout'
          : 'network',
      );
    }
    if (!res.ok) {
      // Drain without reading it into anything that could be logged.
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError(res.status);
    }
    let json: { results?: unknown };
    try {
      json = (await res.json()) as { results?: unknown };
    } catch {
      throw new ProviderError(res.status);
    }
    const results = Array.isArray(json.results)
      ? (json.results as TavilyResult[])
      : [];
    return results.flatMap(toResult).slice(0, req.maxResults);
  }
}

function toResult(r: TavilyResult): WebSearchResult[] {
  if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) return [];
  try {
    new URL(r.url);
  } catch {
    return [];
  }
  const result: WebSearchResult = {
    title: clean(typeof r.title === 'string' ? r.title : '') || r.url,
    url: r.url,
    snippet: trimSnippet(typeof r.content === 'string' ? r.content : ''),
  };
  const published = isoDate(r.published_date);
  if (published) result.publishedAt = published;
  return [result];
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function trimSnippet(s: string): string {
  const text = clean(s);
  return text.length <= SNIPPET_MAX_CHARS
    ? text
    : `${text.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
