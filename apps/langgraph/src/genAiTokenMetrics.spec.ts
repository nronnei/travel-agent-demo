import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { GenAiTokenMetrics } from './genAiTokenMetrics.js';

function setup() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return { provider, reader, exporter };
}

const span = (attributes: ReadableSpan['attributes']) =>
  ({ attributes }) as ReadableSpan;

async function recorded(
  reader: PeriodicExportingMetricReader,
  exporter: InMemoryMetricExporter,
) {
  await reader.forceFlush();
  const points = exporter
    .getMetrics()
    .flatMap((r) => r.scopeMetrics)
    .flatMap((s) => s.metrics)
    .filter((m) => m.descriptor.name === 'gen_ai.client.token.usage')
    .flatMap((m) => (m as HistogramMetricData).dataPoints);
  return points.map((p) => ({ attributes: p.attributes, sum: p.value.sum }));
}

const CHAT = {
  'gen_ai.provider.name': 'anthropic',
  'gen_ai.operation.name': 'chat',
  'gen_ai.request.model': 'claude-sonnet-5-5',
  'gen_ai.response.model': 'claude-sonnet-5-5',
};

afterEach(() => metrics.disable());

describe('GenAiTokenMetrics', () => {
  it('records input (with cache tokens) and output by model', async () => {
    const { provider, reader, exporter } = setup();
    const p = new GenAiTokenMetrics(() => provider.getMeter('t'));
    p.onEnd(
      span({
        ...CHAT,
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 40,
        'gen_ai.usage.cache_read.input_tokens': 1000,
        'gen_ai.usage.cache_creation.input_tokens': 20,
      }),
    );
    expect(await recorded(reader, exporter)).toEqual([
      { attributes: { ...CHAT, 'gen_ai.token.type': 'input' }, sum: 1120 },
      { attributes: { ...CHAT, 'gen_ai.token.type': 'output' }, sum: 40 },
    ]);
  });

  it('ignores spans without usage', async () => {
    const { provider, reader, exporter } = setup();
    const p = new GenAiTokenMetrics(() => provider.getMeter('t'));
    p.onEnd(span({ 'http.route': '/healthz' }));
    expect(await recorded(reader, exporter)).toEqual([]);
  });

  it('works when built before the global meter provider exists', async () => {
    const p = new GenAiTokenMetrics(); // default: the global meter, fetched lazily
    const { provider, reader, exporter } = setup();
    metrics.setGlobalMeterProvider(provider);
    p.onEnd(span({ ...CHAT, 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 2 }));
    const points = await recorded(reader, exporter);
    expect(points.map((x) => x.sum)).toEqual([5, 2]);
  });
});
