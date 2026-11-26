import { flushTelemetry } from './telemetry.js';

const KEY = Symbol.for('travel-agent.otel.shutdown');
const slot = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete slot[KEY];
  vi.useRealTimers();
});

describe('flushTelemetry', () => {
  it('resolves at once when no SDK was started', async () => {
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('calls the SDK shutdown', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    slot[KEY] = shutdown;
    await flushTelemetry();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('gives up at the timeout when the flush hangs', async () => {
    vi.useFakeTimers();
    slot[KEY] = () => new Promise(() => {});
    const done = flushTelemetry(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBeUndefined();
  });

  it('swallows a failing flush', async () => {
    slot[KEY] = () => Promise.reject(new Error('collector down'));
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});
