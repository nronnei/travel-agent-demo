import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { assertToolPairing } from '../test/fakeModel.js';
import {
  CANCELLED_RESULT,
  flattenToolCalls,
  repairHistory,
} from './history.js';

const call = (id: string, name = 'web_search') =>
  new AIMessage({
    content: '',
    tool_calls: [{ id, name, args: { q: id }, type: 'tool_call' }],
  });
const result = (id: string, name = 'web_search') =>
  new ToolMessage({ tool_call_id: id, name, content: 'ok' });

describe('repairHistory', () => {
  it('leaves a valid history alone', () => {
    const history = [
      new HumanMessage('hi'),
      call('a'),
      result('a'),
      new AIMessage('done'),
    ];
    expect(repairHistory(history)).toEqual(history);
  });

  it('answers dangling calls right after their AI message, before the next guest message', () => {
    const history = [
      new HumanMessage('hi'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'a', name: 'web_search', args: {}, type: 'tool_call' },
          { id: 'b', name: 'web_search', args: {}, type: 'tool_call' },
        ],
      }),
      result('a'),
      new HumanMessage('never mind'),
    ];
    const repaired = repairHistory(history);
    assertToolPairing(repaired);
    expect(repaired.map((m) => m.getType())).toEqual([
      'human',
      'ai',
      'tool',
      'tool',
      'human',
    ]);
    expect((repaired[3] as ToolMessage).content).toBe(CANCELLED_RESULT);
  });

  it('drops results that turn up out of place, and never edits AI content', () => {
    const ai = new AIMessage({
      content: [
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'text', text: 'x' },
      ],
      tool_calls: [
        { id: 'a', name: 'web_search', args: {}, type: 'tool_call' },
      ],
    });
    const repaired = repairHistory([ai, new HumanMessage('hi'), result('a')]);
    assertToolPairing(repaired);
    expect(repaired[0]).toBe(ai);
    expect(repaired).toHaveLength(3);
  });
});

describe('flattenToolCalls', () => {
  it('turns widget calls into text and drops their results', () => {
    const flat = flattenToolCalls(
      [
        new HumanMessage('Lisbon'),
        new AIMessage({
          content: 'Here is your brief.',
          tool_calls: [
            {
              id: 'w1',
              name: 'present_brief',
              args: { destination: 'Lisbon' },
              type: 'tool_call',
            },
          ],
        }),
        result('w1', 'present_brief'),
        new HumanMessage('That all looks perfect.'),
        call('s1'),
        result('s1'),
      ],
      new Set(['present_brief']),
    );
    expect(flat.map((m) => m.getType())).toEqual([
      'human',
      'ai',
      'human',
      'ai',
      'tool',
    ]);
    expect(flat[1].content).toBe(
      'Here is your brief.\n[Shown to the guest: present_brief {"destination":"Lisbon"}]',
    );
    expect((flat[1] as AIMessage).tool_calls ?? []).toEqual([]);
  });
});
