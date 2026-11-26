import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

/**
 * Flushes and shuts down the OpenTelemetry SDK started by the preload
 * (`src/instrumentation.ts`), waiting at most `timeoutMs`. Resolves at once
 * when OTEL is off. The app never imports the SDK itself.
 */
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  const shutdown = (globalThis as Record<symbol, unknown>)[
    Symbol.for('travel-agent.otel.shutdown')
  ];
  if (typeof shutdown !== 'function') return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.resolve()
      .then(() => (shutdown as () => Promise<void>)())
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Sends the last telemetry batch when Nest shuts down. Nest awaits every
 * shutdown hook before it re-raises the signal, so the flush isn't cut off.
 */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushTelemetry();
  }
}
