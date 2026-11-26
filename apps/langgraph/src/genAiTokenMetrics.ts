import {
  metrics,
  type Attributes,
  type Context,
  type Histogram,
  type Meter,
} from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace';

const USAGE = {
  input: 'gen_ai.usage.input_tokens',
  output: 'gen_ai.usage.output_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  cacheWrite: 'gen_ai.usage.cache_creation.input_tokens',
} as const;

const LABELS = [
  'gen_ai.provider.name',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
] as const;

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/**
 * Turns the token counts OpenLLMetry's JS Anthropic instrumentation puts on
 * `gen_ai` spans into the semconv histogram `gen_ai.client.token.usage`. The JS
 * instrumentation emits no metrics; the Python one (Parlant) does, and this
 * matches it: `gen_ai.token.type` is `input` (input + cache read + cache
 * write, as Python counts it) or `output`.
 *
 * The meter is fetched on first use: the JS metrics API has no proxy
 * provider, so a meter taken before `sdk.start()` would be a no-op for good.
 */
export class GenAiTokenMetrics implements SpanProcessor {
  private histogram?: Histogram;

  constructor(
    private readonly meter: () => Meter = () =>
      metrics.getMeter('travel-agent-langgraph'),
  ) {}

  onStart(_span: Span, _context: Context): void {}

  onEnd(span: ReadableSpan): void {
    const a = span.attributes;
    if (a[USAGE.input] === undefined && a[USAGE.output] === undefined) return;
    this.histogram ??= this.meter().createHistogram(
      'gen_ai.client.token.usage',
      { description: 'Number of input and output tokens used', unit: '{token}' },
    );
    const labels: Attributes = {};
    for (const k of LABELS) if (a[k] !== undefined) labels[k] = a[k];
    const input =
      count(a[USAGE.input]) +
      count(a[USAGE.cacheRead]) +
      count(a[USAGE.cacheWrite]);
    this.histogram.record(input, { ...labels, 'gen_ai.token.type': 'input' });
    this.histogram.record(count(a[USAGE.output]), {
      ...labels,
      'gen_ai.token.type': 'output',
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
