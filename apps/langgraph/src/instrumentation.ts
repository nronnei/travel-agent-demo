/**
 * OpenTelemetry preload for LangGraph. Same as the API's, plus LLM token
 * usage: OpenLLMetry's Anthropic instrumentation and GenAiTokenMetrics.
 *
 * OpenTelemetry preload, loaded with `node --import` before the app (see the
 * Dockerfile CMD and the `dev` script). It does nothing unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, so tests and OTEL-off deploys load no SDK.
 *
 * Only node: builtins are imported statically. Everything else loads after the
 * ESM hook is registered, so http, undici, Fastify and pg get patched.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const HEALTH = new Set(['/api/health', '/healthz']);
const path = (url?: string) => (url ?? '').split('?')[0];

if (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT &&
  process.env.OTEL_SDK_DISABLED !== 'true'
) {
  // Node 26 deprecates module.register(); use import-in-the-middle's
  // synchronous registerHooks() loader. Resolve it from
  // @opentelemetry/instrumentation so it's the copy the instrumentations use.
  const req = createRequire(import.meta.url);
  const iitm = createRequire(
    req.resolve('@opentelemetry/instrumentation'),
  ).resolve('import-in-the-middle/register-hooks.mjs');
  const hooks = (await import(pathToFileURL(iitm).href)) as {
    register: () => void;
  };
  hooks.register();

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } =
    await import('@opentelemetry/auto-instrumentations-node');
  const { FastifyOtelInstrumentation } = await import('@fastify/otel');
  const { BatchSpanProcessor, ConsoleSpanExporter } =
    await import('@opentelemetry/sdk-trace');
  const { OTLPTraceExporter } =
    await import('@opentelemetry/exporter-trace-otlp-proto');
  const { AnthropicInstrumentation } =
    await import('@traceloop/instrumentation-anthropic');
  const { GenAiTokenMetrics } = await import('./genAiTokenMetrics.js');

  // LLM token usage (OpenLLMetry). Applied by hand: the package's own ESM hook
  // may not see the SDK, and it expects the 0.x SDK's Anthropic.Completions,
  // which 1.x removed. The shim gives it the classes LangChain actually calls
  // (messages.create and beta.messages.create). Prompts and completions are
  // never recorded (traceContent: false).
  const anthropicSdk = await import('@anthropic-ai/sdk');
  const anthropic = new AnthropicInstrumentation({ traceContent: false });
  anthropic.manuallyInstrument({
    ...anthropicSdk,
    Anthropic: {
      Completions: class {
        create() {}
      },
      Messages: anthropicSdk.Anthropic.Messages,
      Beta: anthropicSdk.Anthropic.Beta,
    },
  } as unknown as Parameters<typeof anthropic.manuallyInstrument>[0]);

  // Passing spanProcessors replaces the exporter NodeSDK builds from
  // OTEL_TRACES_EXPORTER, so pick it here (console for the docker gates).
  const tracesExporter = process.env.OTEL_TRACES_EXPORTER ?? 'otlp';
  const spanProcessors = [
    ...(tracesExporter === 'none'
      ? []
      : [
          new BatchSpanProcessor({
            exporter:
              tracesExporter === 'console'
                ? new ConsoleSpanExporter()
                : new OTLPTraceExporter(),
          }),
        ]),
    new GenAiTokenMetrics(),
  ];

  const sdk = new NodeSDK({
    spanProcessors,
    instrumentations: [
      anthropic,
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => HEALTH.has(path(req.url)),
        },
        // Boot retries and migrations make no root spans. Bound parameter
        // values (guest answers, checkpoint blobs) stay unrecorded:
        // enhancedDatabaseReporting is left at its default (off).
        '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
      }),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: (opts) => HEALTH.has(path(opts.url)),
      }),
    ],
  });
  sdk.start();
  // No signal listener here: the app owns shutdown and calls flushTelemetry()
  // last (see telemetry.ts).
  (globalThis as Record<symbol, unknown>)[
    Symbol.for('travel-agent.otel.shutdown')
  ] = () => sdk.shutdown();
}
