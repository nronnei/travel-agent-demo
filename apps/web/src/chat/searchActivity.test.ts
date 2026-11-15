import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_CHIPS,
  emptyActivity,
  finalizeSearch,
  finishSearch,
  fromAiSdkParts,
  messageSearch,
  parlantSearchResults,
  parlantSearchStart,
  sourceChips,
  sourcesFromMarkdown,
  sourcesFromOutput,
  startSearch,
} from './searchActivity';

const src = (n: number | string) => ({
  title: `Source ${n}`,
  url: `https://example.com/${n}`,
});

describe('per-turn search aggregate', () => {
  it('searches until every start has a result, then is done', () => {
    let a = startSearch(emptyActivity('t1'), 's1', 'Lisbon events June');
    expect(a.state).toBe('searching');
    a = finishSearch(a, { id: 'r1', sources: [src(1)] });
    expect(a).toMatchObject({
      state: 'done',
      queries: ['Lisbon events June'],
      sources: [src(1)],
    });
  });

  it('aggregates three searches whose results arrive in another order', () => {
    let a = emptyActivity('t1');
    for (const [id, q] of [
      ['s1', 'Lisbon events'],
      ['s2', 'Lisbon tram hours'],
      ['s3', 'Lisbon museum closures'],
    ])
      a = startSearch(a, id, q);
    a = finishSearch(a, { id: 'r3', sources: [src(3)] });
    a = finishSearch(a, { id: 'r1', sources: [src(1), src(3)] });
    expect(a.state).toBe('searching');
    a = finishSearch(a, { id: 'r2', sources: [src(2)] });
    expect(a.state).toBe('done');
    expect(a.queries).toHaveLength(3);
    expect(a.sources.map((s) => s.url)).toEqual([
      src(3).url,
      src(1).url,
      src(2).url,
    ]);
  });

  it('is an error only when every search failed', () => {
    let all = startSearch(
      startSearch(emptyActivity('t'), 's1', 'a'),
      's2',
      'b',
    );
    all = finishSearch(finishSearch(all, { id: 'r1', error: true }), {
      id: 'r2',
      error: true,
    });
    expect(all.state).toBe('error');

    let some = startSearch(
      startSearch(emptyActivity('t'), 's1', 'a'),
      's2',
      'b',
    );
    some = finishSearch(finishSearch(some, { id: 'r1', error: true }), {
      id: 'r2',
      sources: [src(1)],
    });
    expect(some.state).toBe('done');
  });

  it('ignores a start or result it has already applied', () => {
    let a = startSearch(emptyActivity('t'), 's1', 'q');
    a = startSearch(a, 's1', 'q');
    a = finishSearch(a, { id: 'r1', sources: [src(1)] });
    a = finishSearch(a, { id: 'r1', sources: [src(2)] });
    expect(a).toMatchObject({
      state: 'done',
      started: ['s1'],
      finished: ['r1'],
    });
    expect(a.sources).toEqual([src(1)]);
  });

  it('settles at turn end: done with results, error without', () => {
    const started = startSearch(
      startSearch(emptyActivity('t'), 's1', 'a'),
      's2',
      'b',
    );
    expect(finalizeSearch(started).state).toBe('error');
    expect(
      finalizeSearch(finishSearch(started, { id: 'r1', sources: [] })).state,
    ).toBe('done');
  });

  it('deduplicates by URL, drops non-http(s) URLs and caps the chips', () => {
    let a = startSearch(emptyActivity('t'), 's1', 'q');
    a = finishSearch(a, {
      id: 'r1',
      sources: [
        ...Array.from({ length: 8 }, (_, i) => src(i)),
        src(0),
        { title: 'x', url: 'javascript:alert(1)' },
        { title: 'y', url: 'data:text/html,hi' },
        { title: 'z', url: 'not a url' },
        { url: 'https://example.com/untitled' },
      ],
    });
    expect(a.sources).toHaveLength(8);
    expect(sourceChips(a)).toHaveLength(MAX_SOURCE_CHIPS);
    expect(a.sources.every((s) => s.url.startsWith('https://'))).toBe(true);
  });
});

describe('Parlant events', () => {
  it('reads the web-search custom event', () => {
    expect(
      parlantSearchStart({
        type: 'web-search',
        state: 'searching',
        query: 'q',
      }),
    ).toEqual({ query: 'q' });
    expect(parlantSearchStart({ type: 'other' })).toBeUndefined();
  });

  it('reads search metadata from a tool event, one outcome per call', () => {
    const data = {
      tool_calls: [
        {
          tool_id: 'built-in:web_search',
          result: {
            data: {},
            metadata: { search: { query: 'a', sources: [src(1)] } },
          },
        },
        {
          tool_id: 'built-in:web_search',
          result: {
            data: 'x',
            metadata: { search: { query: 'b', error: true } },
          },
        },
        {
          tool_id: 'built-in:present_brief',
          result: { data: 'x', metadata: { widget: {} } },
        },
      ],
    };
    expect(parlantSearchResults('e9', data)).toEqual([
      { id: 'e9:0', query: 'a', sources: [src(1)] },
      { id: 'e9:1', query: 'b', error: true },
    ]);
  });
});

describe('Inkeep (AI SDK parts)', () => {
  const response = (urls: number[]) =>
    JSON.stringify({
      query: 'q',
      searchedAt: '2027-06-01T00:00:00Z',
      results: urls.map((n) => ({ ...src(n), snippet: 's' })),
    });
  const toolPart = (state: string, extra: object = {}) =>
    ({
      type: 'dynamic-tool',
      toolName: 'web_search',
      toolCallId: `call-${state}`,
      state,
      input: { query: 'Lisbon events' },
      ...extra,
    }) as unknown as UIMessage['parts'][number];
  const msg = (...parts: UIMessage['parts']): UIMessage => ({
    id: 'm1',
    role: 'assistant',
    parts,
  });

  it('is searching while input is available', () => {
    const out = fromAiSdkParts(msg(toolPart('input-available')), false);
    expect(messageSearch(out)).toMatchObject({
      state: 'searching',
      queries: ['Lisbon events'],
    });
  });

  it('is done with sources from MCP content output', () => {
    const output = { content: [{ type: 'text', text: response([1, 2]) }] };
    const out = fromAiSdkParts(
      msg(toolPart('output-available', { output })),
      false,
    );
    expect(messageSearch(out)).toMatchObject({
      state: 'done',
      sources: [src(1), src(2)],
    });
  });

  it('reads static tool parts and plain JSON output too', () => {
    const part = {
      ...toolPart('output-available', { output: response([3]) }),
      type: 'tool-web_search',
    } as UIMessage['parts'][number];
    expect(messageSearch(fromAiSdkParts(msg(part), false))?.sources).toEqual([
      src(3),
    ]);
  });

  it('treats MCP isError output and output-error as failures', () => {
    const failed = fromAiSdkParts(
      msg(
        toolPart('output-available', {
          output: { isError: true, content: [{ type: 'text', text: 'x' }] },
        }),
      ),
      false,
    );
    expect(messageSearch(failed)?.state).toBe('error');
    expect(
      messageSearch(fromAiSdkParts(msg(toolPart('output-error')), false))
        ?.state,
    ).toBe('error');
  });

  it('settles once the message is final', () => {
    const out = fromAiSdkParts(msg(toolPart('input-available')), true);
    expect(messageSearch(out)?.state).toBe('error');
  });

  it('leaves messages without search tool parts alone', () => {
    const m = msg({ type: 'text', text: 'See [x](https://example.com/x).' });
    expect(fromAiSdkParts(m, true)).toBe(m);
  });

  it('parses sources from unknown output shapes defensively', () => {
    expect(sourcesFromOutput(undefined)).toEqual([]);
    expect(sourcesFromOutput('not json')).toEqual([]);
  });
});

describe('sourcesFromMarkdown (fallback)', () => {
  it('takes http(s) links, not images, deduplicated', () => {
    const text =
      'See [Festas](https://example.com/a) and [again](https://example.com/a), ' +
      '![pic](https://evil.example/p.png) and [bad](javascript:alert(1)).';
    expect(sourcesFromMarkdown(text)).toEqual([
      { title: 'Festas', url: 'https://example.com/a' },
    ]);
  });
});
