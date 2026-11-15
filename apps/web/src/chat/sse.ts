/** One Server-Sent Events frame. */
export interface SseFrame {
  id?: string;
  data: string;
}

/**
 * Reads an SSE response body frame by frame. `fetch` rather than EventSource,
 * because every request must carry the conversation key header. Comments
 * (keep-alives) and `retry:` lines are skipped.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = parseFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (frame) onFrame(frame);
    }
  }
}

export function parseFrame(text: string): SseFrame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { id, data: data.join('\n') } : undefined;
}
