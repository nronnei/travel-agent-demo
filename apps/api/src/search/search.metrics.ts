import { Injectable } from '@nestjs/common';
import { metrics, type Counter } from '@opentelemetry/api';
import { SearchClients, type SearchClient } from '@travel-agent/shared';

/** How a search ended. Invalid requests aren't searches, so they aren't counted. */
export const SearchOutcomes = ['ok', 'cached', 'limited', 'error', 'off'] as const;
export type SearchOutcome = (typeof SearchOutcomes)[number];

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
    // Start every series at 0. Prometheus' increase() takes a new series' first
    // sample as its baseline, so a series first exported at 3 would count as 0.
    for (const client of [...SearchClients, 'unknown'] as const) {
      this.creditsUsed.add(0, { client });
      for (const outcome of SearchOutcomes)
        this.requests.add(0, { client, outcome });
    }
  }

  request(client: SearchClient, outcome: SearchOutcome): void {
    this.requests.add(1, { client, outcome });
  }

  credits(client: SearchClient, n: number): void {
    this.creditsUsed.add(n, { client });
  }
}
