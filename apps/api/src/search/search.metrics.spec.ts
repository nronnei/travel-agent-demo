import { metrics } from '@opentelemetry/api';
import { SearchMetrics } from './search.metrics.js';

afterEach(() => vi.restoreAllMocks());

describe('SearchMetrics', () => {
  it('starts every client × outcome series, and credits per client, at 0', () => {
    const adds: { name: string; n: number; attrs: unknown }[] = [];
    vi.spyOn(metrics, 'getMeter').mockReturnValue({
      createCounter: (name: string) => ({
        add: (n: number, attrs: unknown) => adds.push({ name, n, attrs }),
      }),
    } as never);
    new SearchMetrics();
    const requests = adds.filter((a) => a.name === 'travel_agent.search.requests');
    const credits = adds.filter((a) => a.name === 'travel_agent.search.credits');
    expect(requests).toHaveLength(4 * 5);
    expect(credits).toHaveLength(4);
    expect(adds.every((a) => a.n === 0)).toBe(true);
    expect(requests).toContainEqual({
      name: 'travel_agent.search.requests',
      n: 0,
      attrs: { client: 'inkeep', outcome: 'ok' },
    });
  });
});
