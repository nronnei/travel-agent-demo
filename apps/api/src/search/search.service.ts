import { createHash } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WebSearchRequestSchema,
  type WebSearchResponse,
  type WebSearchResult,
} from '@travel-agent/shared';
import {
  ProviderError,
  SEARCH_PROVIDER,
  type ProviderRequest,
  type SearchProvider,
} from './search.provider.js';

const PROVIDER_TIMEOUT_MS = 8000;
const CACHE_MAX_ENTRIES = 500;

export type LimitReason = 'rate' | 'daily';

/** Thrown when over a limit; `reason` tells the caller (and the log) which one. */
export class SearchLimitedException extends HttpException {
  constructor(readonly reason: LimitReason) {
    super(
      reason === 'rate'
        ? 'Too many searches right now'
        : 'The daily search limit is reached',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

interface CacheEntry {
  expires: number;
  results: WebSearchResult[];
}

/**
 * Web search with a cache, a per-minute rate limit and a daily cap in front of
 * the provider. The limits are best-effort guards for this process: they reset
 * on restart. The hard cost ceiling is set at the provider.
 *
 * Logs never carry the raw query (guests may put personal details in a trip
 * request): only its length and an 8-char sha256 prefix.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger('Search');
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ratePerMinute: number;
  private readonly dailyLimit: number;
  private readonly cacheTtlMs: number;
  private tokens: number;
  private refilledAt: number;
  private day = '';
  private dayCount = 0;

  constructor(
    @Inject(SEARCH_PROVIDER) private readonly provider: SearchProvider,
    config: ConfigService,
  ) {
    this.ratePerMinute = positiveInt(config.get('SEARCH_RATE_PER_MINUTE'), 30);
    this.dailyLimit = positiveInt(config.get('SEARCH_DAILY_LIMIT'), 500);
    this.cacheTtlMs =
      positiveInt(config.get('SEARCH_CACHE_TTL_SECONDS'), 900) * 1000;
    this.tokens = this.ratePerMinute;
    this.refilledAt = Date.now();
  }

  get enabled(): boolean {
    return this.provider.enabled;
  }

  async search(input: unknown): Promise<WebSearchResponse> {
    const parsed = WebSearchRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const req: ProviderRequest = parsed.data;
    const started = Date.now();
    const tag = `len=${req.query.length} q=${hash(req.query)}`;

    if (!this.provider.enabled) {
      this.logger.warn(`search off ${tag}`);
      throw new ServiceUnavailableException('Web search is turned off');
    }

    const key = cacheKey(req);
    const hit = this.cache.get(key);
    if (hit && hit.expires > started) {
      this.logger.log(`search cached ${tag} results=${hit.results.length}`);
      return this.response(req, hit.results);
    }
    if (hit) this.cache.delete(key);

    const limited = this.takeToken(started);
    if (limited) {
      this.logger.warn(`search limited reason=${limited} ${tag}`);
      throw new SearchLimitedException(limited);
    }

    let results: WebSearchResult[];
    try {
      results = await this.provider.search(
        req,
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      );
    } catch (err) {
      const status =
        err instanceof ProviderError
          ? err.status
          : err instanceof HttpException
            ? err.getStatus()
            : 'unknown';
      this.logger.warn(
        `search error status=${status} ${tag} ms=${Date.now() - started}`,
      );
      throw new ServiceUnavailableException('Web search is unavailable');
    }

    this.store(key, results, Date.now());
    this.logger.log(
      `search ok ${tag} results=${results.length} ms=${Date.now() - started}`,
    );
    return this.response(req, results);
  }

  private response(
    req: ProviderRequest,
    results: WebSearchResult[],
  ): WebSearchResponse {
    return {
      query: req.query,
      searchedAt: new Date().toISOString(),
      results,
    };
  }

  /** Token bucket plus the daily cap. Returns the reason when over a limit. */
  private takeToken(now: number): LimitReason | undefined {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.dailyLimit) return 'daily';

    const elapsed = now - this.refilledAt;
    this.tokens = Math.min(
      this.ratePerMinute,
      this.tokens + (elapsed / 60_000) * this.ratePerMinute,
    );
    this.refilledAt = now;
    if (this.tokens < 1) return 'rate';

    this.tokens -= 1;
    this.dayCount += 1;
    return undefined;
  }

  private store(key: string, results: WebSearchResult[], now: number) {
    this.cache.delete(key);
    this.cache.set(key, { expires: now + this.cacheTtlMs, results });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function cacheKey(req: ProviderRequest): string {
  const q = req.query.toLowerCase().replace(/\s+/g, ' ').trim();
  return JSON.stringify([q, req.maxResults, req.recencyDays ?? null]);
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
