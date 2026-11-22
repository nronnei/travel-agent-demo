import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { mergeGraphMessages, type GraphMessage } from './langgraphMessages';

const human = (id: string, content: string): GraphMessage => ({
  type: 'human',
  id,
  content,
});
const ai = (
  id: string,
  content: string,
  tool_calls: GraphMessage['tool_calls'] = [],
): GraphMessage => ({
  type: 'ai',
  id,
  content,
  tool_calls,
});
const tool = (
  tool_call_id: string,
  name: string,
  content: string,
  artifact?: unknown,
): GraphMessage => ({
  type: 'tool',
  id: `t-${tool_call_id}`,
  tool_call_id,
  name,
  content,
  artifact,
});

const picker = {
  name: 'InterestPicker',
  props: {
    prompt: 'What should your time in Lisbon focus on?',
    extras: [],
    selected: [],
  },
};
const scripted: UIMessage = {
  id: 'local-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Where would you like to travel?' }],
};
const guest: UIMessage = {
  id: 'local-2',
  role: 'user',
  parts: [{ type: 'text', text: 'Lisbon' }],
};

describe('mergeGraphMessages', () => {
  it('appends a text-only reply after the local messages, skipping the guest message', () => {
    const merged = mergeGraphMessages(
      [scripted, guest],
      [human('h1', 'Lisbon'), ai('a1', 'Lovely.')],
    );
    expect(merged.map((m) => m.id)).toEqual(['local-1', 'local-2', 'a1']);
    expect(merged[2].parts).toEqual([{ type: 'text', text: 'Lovely.' }]);
  });

  it('shows a widget from its tool call, and drops a malformed one', () => {
    const graph = [
      human('h1', 'A getaway'),
      ai('a1', 'Splendid.', [
        { id: 'w1', name: 'suggest_interests', args: {} },
        { id: 'w2', name: 'present_brief', args: {} },
      ]),
    ];
    const merged = mergeGraphMessages([], graph, {
      w1: picker,
      w2: { name: 'TripBrief', props: {} },
    });
    expect(merged[0].parts).toEqual([
      { type: 'text', text: 'Splendid.' },
      { type: 'data-component', data: picker },
    ]);
  });

  it('renders a search turn as one bubble: indicator while searching, chips after', () => {
    const call = ai('a1', '', [
      { id: 's1', name: 'web_search', args: { query: 'Lisbon June' } },
    ]);
    const searching = mergeGraphMessages(
      [],
      [human('h1', 'Events?'), call],
      {},
      true,
    );
    expect(searching).toHaveLength(1);
    expect(searching[0].parts).toEqual([
      {
        type: 'data-search',
        data: expect.objectContaining({
          state: 'searching',
          queries: ['Lisbon June'],
        }),
      },
    ]);

    const done = mergeGraphMessages(
      searching,
      [
        human('h1', 'Events?'),
        call,
        tool('s1', 'web_search', '{}', {
          search: {
            query: 'Lisbon June',
            sources: [{ title: 'A', url: 'https://example.com/a' }],
          },
        }),
        ai('a2', 'The Santo António festival.'),
      ],
      {},
      false,
    );
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe('a1');
    expect(done[0].parts[0]).toEqual({
      type: 'text',
      text: 'The Santo António festival.',
    });
    expect(done[0].parts[1]).toEqual({
      type: 'data-search',
      data: expect.objectContaining({
        state: 'done',
        sources: [{ title: 'A', url: 'https://example.com/a' }],
      }),
    });
  });

  it('settles a search left unfinished once the run ends', () => {
    const call = ai('a1', '', [
      { id: 's1', name: 'web_search', args: { query: 'q' } },
    ]);
    const merged = mergeGraphMessages([], [human('h1', 'x'), call], {}, false);
    expect(merged[0].parts[0]).toEqual({
      type: 'data-search',
      data: expect.objectContaining({ state: 'error' }),
    });
  });

  it('replaces a streaming copy with its final copy instead of adding another', () => {
    const streaming = mergeGraphMessages(
      [guest],
      [human('h1', 'x'), ai('a1', 'Lov')],
      {},
      true,
    );
    const final = mergeGraphMessages(streaming, [
      human('h1', 'x'),
      ai('a1', 'Lovely.'),
    ]);
    expect(final.map((m) => m.id)).toEqual(['local-2', 'a1']);
    expect(final[1].parts).toEqual([{ type: 'text', text: 'Lovely.' }]);
  });

  it('starts a new turn after a widget answer, and keeps earlier turns in place', () => {
    const first = [
      human('h1', 'A getaway'),
      ai('a1', 'Splendid.', [{ id: 'w1', name: 'suggest_interests' }]),
    ];
    const afterPick = mergeGraphMessages([guest], first, { w1: picker });
    const local: UIMessage = {
      id: 'local-3',
      role: 'user',
      parts: [{ type: 'text', text: 'Food' }],
    };
    const next = mergeGraphMessages(
      [...afterPick, local],
      [
        ...first,
        tool('w1', 'suggest_interests', 'The guest picked: Food & drink.'),
        ai('a2', 'Here is your brief.'),
      ],
      { w1: picker },
    );
    expect(next.map((m) => m.id)).toEqual(['local-2', 'a1', 'local-3', 'a2']);
  });

  it('keeps a "Not shown" retry in the same turn', () => {
    const merged = mergeGraphMessages(
      [],
      [
        human('h1', 'x'),
        ai('a1', 'Here is your trip brief.', [
          { id: 'w1', name: 'present_brief' },
        ]),
        tool('w1', 'present_brief', 'Not shown: a detail is missing.'),
        ai('a2', 'What brings you there?'),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].parts).toEqual([
      { type: 'text', text: 'What brings you there?' },
    ]);
  });

  it('reads text from content blocks', () => {
    const merged = mergeGraphMessages(
      [],
      [
        human('h1', 'x'),
        {
          type: 'ai',
          id: 'a1',
          content: [
            { type: 'text', text: 'Hi ' },
            { type: 'text', text: 'there' },
          ],
        },
      ],
    );
    expect(merged[0].parts).toEqual([{ type: 'text', text: 'Hi there' }]);
  });
});
