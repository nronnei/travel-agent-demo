import { Injectable } from '@nestjs/common';
import { metrics, type Counter } from '@opentelemetry/api';
import type { SearchClient } from '@travel-agent/shared';

/** How a search ended. Invalid requests aren't searches, so they aren't counted. */
export type SearchOutcome = 'ok' | 'cached' | 'limited' | 'error' | 'off';

/**
 * The two search cost counters. Without an OTEL SDK (tests, OTEL off) the
 * global meter is a no-op. Nest builds this after the preload has started the
 * SDK, so the meter it gets here is the real one.
 */
@Injectable()
export class SearchMetrics {
  private readonly requests: Counter;
  private readonly creditsUsed: Counter;

  constructor() {
    const meter = metrics.getMeter('travel-agent-api');
    this.requests = meter.createCounter('travel_agent.search.requests', {
      description: 'Web searches by calling backend and outcome',
    });
    this.creditsUsed = meter.createCounter('travel_agent.search.credits', {
      description:
        'Provider credits reported per search (a lower bound: timed-out calls may still be billed)',
    });
  }

  request(client: SearchClient, outcome: SearchOutcome): void {
    this.requests.add(1, { client, outcome });
  }

  credits(client: SearchClient, n: number): void {
    this.creditsUsed.add(n, { client });
  }
}
