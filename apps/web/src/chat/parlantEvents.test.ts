import { describe, expect, it } from 'vitest';
import {
  applyParlantEvent,
  initialParlantState,
  type ParlantChatState,
  type ParlantEvent,
} from './parlantEvents';

// Shapes as Parlant 4.0.5 sent them in the spike run.
let offset = 0;
const ev = (
  kind: ParlantEvent['kind'],
  data: unknown,
  { trace = 't1', source = 'ai_agent', id = `e${offset + 1}` } = {},
): ParlantEvent => ({
  id,
  offset: ++offset,
  kind,
  source,
  trace_id: trace,
  data,
});
const status = (s: string, trace = 't1') =>
  ev('status', { status: s }, { trace });
const message = (
  text: string,
  opts: { chunks?: (string | null)[]; id?: string; trace?: string } = {},
) =>
  ev(
    'message',
    { message: text, chunks: opts.chunks },
    { id: opts.id, trace: opts.trace },
  );
const picker = {
  name: 'InterestPicker',
  props: { prompt: 'What should Lisbon focus on?', extras: [] },
};
const tool = (...widgets: unknown[]) =>
  ev(
    'tool',
    {
      tool_calls: widgets.map((widget) => ({
        tool_id: 'built-in:suggest_interests',
        arguments: {},
        result: { data: 'shown', metadata: { widget } },
      })),
    },
    { source: 'system' },
  );

const run = (...events: ParlantEvent[]): ParlantChatState =>
  events.reduce(applyParlantEvent, initialParlantState);

describe('applyParlantEvent', () => {
  it('tracks a turn through its status events', () => {
    expect(run(status('acknowledged'))).toMatchObject({
      busy: true,
      typing: false,
    });
    expect(run(status('processing'), status('typing'))).toMatchObject({
      busy: true,
      typing: true,
    });
    expect(run(status('typing'), status('ready'))).toMatchObject({
      busy: false,
      typing: false,
    });
    expect(run(status('typing'), status('cancelled')).busy).toBe(false);
  });

  it('shows what the agent is doing until it starts typing, never its reasoning', () => {
    const steps = (...events: ParlantEvent[]) =>
      events.reduce(applyParlantEvent, initialParlantState).activity;
    const reasoning = ev('status', {
      status: 'processing',
      message: 'The guest wants Lisbon, so I should',
      chunks: ['The guest wants Lisbon, so I should'],
    });
    const stage = (m: string) =>
      ev('status', { status: 'processing', message: m });

    expect(steps(status('acknowledged'), stage('Thinking'))).toBe('Thinking…');
    expect(steps(stage('Running tools'))).toBe('Working on it…');
    expect(steps(stage('Looking up Lisbon'))).toBe('Looking up Lisbon');
    expect(steps(reasoning)).toBe('Thinking…');
    // An empty or overlong message keeps the last label.
    expect(
      steps(stage('Running tools'), stage(''), stage('x'.repeat(200))),
    ).toBe('Working on it…');
    expect(steps(stage('Thinking'), status('typing'))).toBeUndefined();
    expect(steps(stage('Thinking'), status('ready'))).toBeUndefined();
  });

  it("adds agent messages, not the guest's own", () => {
    const state = run(
      ev('message', { message: 'Lisbon' }, { source: 'customer' }),
      message('Lisbon, lovely.', { chunks: ['Lisbon, ', 'lovely.', null] }),
      message('Shall I suggest a few areas?'),
    );
    expect(state.messages.map((m) => [m.role, m.parts])).toEqual([
      ['assistant', [{ type: 'text', text: 'Lisbon, lovely.' }]],
      ['assistant', [{ type: 'text', text: 'Shall I suggest a few areas?' }]],
    ]);
  });

  it("puts a turn's widgets on its message, dropping malformed ones", () => {
    const state = run(
      tool(
        picker,
        { name: 'InterestPicker', props: {} },
        { name: 'Bogus', props: {} },
      ),
      message('Sounds lovely.'),
      status('ready'),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toEqual([
      { type: 'text', text: 'Sounds lovely.' },
      {
        type: 'data-component',
        data: { ...picker, props: { ...picker.props, selected: [] } },
      },
    ]);
    expect(state.widgets).toEqual({});
  });

  it('shows widgets from a turn with no message once it is ready', () => {
    const state = run(tool(picker), status('ready'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts[0]).toMatchObject({
      type: 'data-component',
    });
  });

  it('follows a streaming message until its chunks end in null', () => {
    let state = run(
      tool(picker),
      message('Sounds', { id: 'm1', chunks: ['Sounds'] }),
    );
    expect(state.streaming).toEqual(['m1']);
    // The per-event stream re-sends the same event as it grows.
    state = applyParlantEvent(state, {
      ...message('Sounds lovely.', {
        id: 'm1',
        chunks: ['Sounds', ' lovely.', null],
      }),
    });
    expect(state.streaming).toEqual([]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toEqual([
      { type: 'text', text: 'Sounds lovely.' },
      expect.objectContaining({ type: 'data-component' }),
    ]);
  });

  it('shows agent errors the way the chat shows Inkeep errors', () => {
    const state = run(status('typing'), status('error'));
    expect(state.busy).toBe(false);
    expect(state.messages[0].parts[0]).toMatchObject({
      type: 'data-operation',
      data: { type: 'error' },
    });
  });

  it('keeps the highest offset, to resume the stream from', () => {
    const state = run(status('acknowledged'), status('ready'));
    expect(state.offset).toBe(offset);
  });

  it('keeps messages that arrive after the turn is ready', () => {
    const state = run(
      status('ready'),
      message('One more thing...', { trace: 't2' }),
    );
    expect(state.messages).toHaveLength(1);
  });
});

describe('web search activity', () => {
  const searching = (query: string, trace = 't1') =>
    ev(
      'custom',
      { type: 'web-search', state: 'searching', query },
      { trace, source: 'system' },
    );
  const searchResult = (
    searches: { query: string; sources?: unknown[]; error?: boolean }[],
    trace = 't1',
  ) =>
    ev(
      'tool',
      {
        tool_calls: searches.map((search) => ({
          tool_id: 'built-in:web_search',
          arguments: { query: search.query },
          result: { data: {}, metadata: { search } },
        })),
      },
      { trace, source: 'system' },
    );
  const festas = { title: 'Festas', url: 'https://example.com/festas' };
  const searchOf = (state: ParlantChatState, id: string) =>
    state.messages
      .find((m) => m.id === id)
      ?.parts.find((p) => p.type === 'data-search') as
      | { data: { state: string; queries: string[]; sources: unknown[] } }
      | undefined;

  it('shows a placeholder while searching before any text', () => {
    const state = run(status('processing'), searching('Lisbon events'));
    expect(state.messages.map((m) => m.id)).toEqual(['parlant-search-t1']);
    expect(searchOf(state, 'parlant-search-t1')?.data).toMatchObject({
      state: 'searching',
      queries: ['Lisbon events'],
    });
  });

  it("moves the search onto the turn's first message, and keeps it while streaming", () => {
    const state = run(
      searching('Lisbon events'),
      searchResult([{ query: 'Lisbon events', sources: [festas] }]),
      message('Here', { id: 'm1', chunks: ['Here'] }),
      message('Here is what is on', {
        id: 'm1',
        chunks: ['Here', ' is what is on', null],
      }),
    );
    expect(state.messages.map((m) => m.id)).toEqual(['parlant-m1']);
    expect(state.messages[0].parts[0]).toEqual({
      type: 'text',
      text: 'Here is what is on',
    });
    expect(searchOf(state, 'parlant-m1')?.data).toMatchObject({
      state: 'done',
      sources: [festas],
    });
  });

  it('adds a search that starts after text has streamed to that message', () => {
    const state = run(
      message('Let me check', { id: 'm1' }),
      searching('Lisbon tram hours'),
    );
    expect(state.messages.map((m) => m.id)).toEqual(['parlant-m1']);
    expect(searchOf(state, 'parlant-m1')?.data.state).toBe('searching');
  });

  it('aggregates a turn with several searches, results in a batch', () => {
    const state = run(
      searching('a'),
      searching('b'),
      searching('c'),
      searchResult([
        { query: 'c', sources: [festas] },
        { query: 'a', error: true },
        { query: 'b', sources: [festas] },
      ]),
    );
    expect(searchOf(state, 'parlant-search-t1')?.data).toMatchObject({
      state: 'done',
      queries: ['a', 'b', 'c'],
      sources: [festas],
    });
  });

  it.each(['ready', 'cancelled', 'error'])(
    'settles a search still running when the turn ends (%s)',
    (end) => {
      const noResults = run(searching('Lisbon events'), status(end));
      expect(searchOf(noResults, 'parlant-search-t1')?.data.state).toBe(
        'error',
      );

      const someResults = run(
        searching('a'),
        searching('b'),
        searchResult([{ query: 'a', sources: [festas] }]),
        message('Answer', { id: 'm1' }),
        status(end),
      );
      expect(searchOf(someResults, 'parlant-m1')?.data.state).toBe('done');
    },
  );

  it('keeps searches of different turns apart', () => {
    const state = run(
      searching('a', 't1'),
      searchResult([{ query: 'a', sources: [festas] }], 't1'),
      message('One', { id: 'm1', trace: 't1' }),
      status('ready', 't1'),
      searching('b', 't2'),
    );
    expect(searchOf(state, 'parlant-m1')?.data.state).toBe('done');
    expect(searchOf(state, 'parlant-search-t2')?.data.state).toBe('searching');
  });

  it('gives the same state when events are replayed on reconnect', () => {
    const events = [
      status('processing'),
      searching('Lisbon events'),
      searchResult([{ query: 'Lisbon events', sources: [festas] }]),
      message('Answer', { id: 'm1' }),
      status('ready'),
    ];
    const once = run(...events);
    const twice = events.reduce(applyParlantEvent, once);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.searches).toEqual(once.searches);
  });
});
