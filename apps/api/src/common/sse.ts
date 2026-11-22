import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply } from 'fastify';

/**
 * Streams an upstream SSE response through to the browser, closing upstream
 * when the browser goes. `x-accel-buffering: no` stops nginx (the web
 * container, the ingress) from buffering it.
 */
export async function pipeSse(
  reply: FastifyReply,
  open: (signal: AbortSignal) => Promise<Response>,
) {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  const res = await open(abort.signal);
  // fetch's web stream is typed against DOM lib; it is Node's implementation at runtime.
  const body = Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
  // An aborted upstream read errors the stream; the browser has gone anyway.
  body.on('error', () => undefined);
  return reply
    .header('content-type', 'text/event-stream')
    .header('cache-control', 'no-cache, no-transform')
    .header('x-accel-buffering', 'no')
    .send(body);
}
