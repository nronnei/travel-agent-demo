import { describe, expect, it } from 'vitest';
import { readSse, type SseFrame } from './sse';

function body(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readSse', () => {
  it("parses Parlant's frames across chunk boundaries, skipping retry and keep-alives", async () => {
    const frames: SseFrame[] = [];
    await readSse(
      body(
        'retry: 3000\n\n',
        'id: 1\ndata: {"a"',
        ':1}\n\n: keep-alive\n\n',
        'id: 2\r\ndata: x\r\ndata: y\r\n\r\n',
      ),
      (f) => frames.push(f),
    );
    expect(frames).toEqual([
      { id: '1', data: '{"a":1}' },
      { id: '2', data: 'x\ny' },
    ]);
  });
});
