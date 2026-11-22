import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { IntakeContext } from '@travel-agent/shared';
import { FakeChatModel, callTool } from '../test/fakeModel.js';
import type { IntakeClient, SearchClient } from './apiClient.js';
import { buildGraph, NOT_SHOWN, RECURSION_LIMIT } from './graph.js';
import { CANCELLED_RESULT } from './history.js';
import { INTAKE_FALLBACK_LINE } from './prompts.js';

const baseIntake: IntakeContext = {
  address: 'Dr Lima',
  givenName: 'Ana',
  surname: 'Lima',
  prefix: 'Dr',
  destination: '',
  purpose: '',
  interests: '',
  briefConfirmed: 'no',
};

function setup() {
  const intake = { ...baseIntake };
  const drafts: unknown[] = [];
  const intakeClient = {
    context: vi.fn(async () => ({ ...intake })),
    saveDraft: vi.fn(
      async (_: string, brief: unknown) => void drafts.push(brief),
    ),
  } as unknown as IntakeClient;
  const search = vi.fn(async ({ query }: { query: string }) => ({
    query,
    searchedAt: '2026-11-22T00:00:00Z',
    results: [{ title: 'A', url: 'https://example.com/a', snippet: 's' }],
  }));
  const searchClient = { search } as unknown as SearchClient;
  const intakeModel = new FakeChatModel();
  const plannerModel = new FakeChatModel();
  const graph = buildGraph({
    models: { intake: intakeModel, planner: plannerModel },
    intakeClient,
    searchClient,
    checkpointer: new MemorySaver(),
  });
  const config = {
    configurable: { thread_id: 'thread-1', conversation_id: 'conv-1' },
    recursionLimit: RECURSION_LIMIT,
  };
  const run = (input: unknown, signal?: AbortSignal) =>
    graph.invoke(input as never, { ...config, signal });
  const say = (text: string, signal?: AbortSignal) =>
    run({ messages: [new HumanMessage(text)] }, signal);
  const state = () => graph.getState(config);
  return {
    intake,
    drafts,
    intakeModel,
    plannerModel,
    graph,
    run,
    say,
    state,
    search,
  };
}

const brief = { destination: 'Lisbon', purpose: 'a food tour', interests: [] };

describe('the graph', () => {
  it('routes an unconfirmed intake to the intake model', async () => {
    const t = setup();
    t.intakeModel.push(new AIMessage('And what brings you to Lisbon?'));
    await t.say('Lisbon');
    expect(t.intakeModel.calls).toHaveLength(1);
    expect(t.plannerModel.calls).toHaveLength(0);
    expect(t.intakeModel.calls[0].tools).toEqual([
      'suggest_interests',
      'present_brief',
    ]);
  });

  it('routes a confirmed intake to the planner', async () => {
    const t = setup();
    t.intake.briefConfirmed = 'yes';
    t.plannerModel.push(new AIMessage('Here is a plan.'));
    await t.say('Plan it');
    expect(t.plannerModel.calls).toHaveLength(1);
    expect(t.intakeModel.calls).toHaveLength(0);
  });

  it('pauses on an interest picker and resumes with the answer', async () => {
    const t = setup();
    t.intakeModel.push(
      callTool(
        'suggest_interests',
        { destination: 'Lisbon', extras: ['Fado music'] },
        'w1',
      ),
    );
    await t.say('A getaway with my partner');
    const paused = await t.state();
    expect(paused.next).toEqual(['awaitGuest']);
    const value = paused.tasks[0].interrupts[0].value as {
      widget: { name: string };
    };
    expect(value.widget.name).toBe('InterestPicker');
    expect(paused.values.widgets.w1.name).toBe('InterestPicker');

    t.intakeModel.push(callTool('present_brief', brief, 'w2'));
    await t.run(
      new Command({ resume: { type: 'interests', labels: ['Food & drink'] } }),
    );
    const answer = t.intakeModel.calls[1].messages.find(
      (m) => ToolMessage.isInstance(m) && m.tool_call_id === 'w1',
    );
    expect(answer?.content).toBe('The guest picked: Food & drink.');
    expect((await t.state()).next).toEqual(['awaitGuest']);
  });

  it('saves the brief draft at most twice per resume cycle', async () => {
    const t = setup();
    t.intakeModel.push(callTool('present_brief', brief, 'w1'));
    await t.say('A food tour');
    expect(t.drafts.length).toBeGreaterThanOrEqual(1);
    expect(t.drafts.length).toBeLessThanOrEqual(2);
    expect(t.drafts[0]).toEqual(brief);
  });

  it('hands off to the planner in the same run once the guest confirms', async () => {
    const t = setup();
    t.intakeModel.push(callTool('present_brief', brief, 'w1'));
    await t.say('A food tour');
    t.intake.briefConfirmed = 'yes';
    t.plannerModel.push(
      new AIMessage("Wonderful. Let's start planning your trip."),
    );
    const result = await t.run(new Command({ resume: { type: 'confirm' } }));
    expect(t.plannerModel.calls).toHaveLength(1);
    expect(result.messages.at(-1)?.content).toContain('start planning');
  });

  it('treats an answer that does not fit the widget as a reply', async () => {
    const t = setup();
    t.intakeModel.push(callTool('present_brief', brief, 'w1'));
    await t.say('A food tour');
    t.intakeModel.push(new AIMessage('Noted.'));
    await t.run(
      new Command({ resume: { type: 'interests', labels: ['Beaches'] } }),
    );
    const answer = t.intakeModel.calls[1].messages.find(
      (m) => ToolMessage.isInstance(m) && m.tool_call_id === 'w1',
    );
    expect(answer?.content).toBe(
      "The guest answered in their own words: I'd like the trip to focus on: Beaches.",
    );
  });

  it('does not show an invalid brief, and asks the model again', async () => {
    const t = setup();
    t.intakeModel.push(
      callTool(
        'present_brief',
        { destination: 'Lisbon', purpose: '<UNKNOWN>' },
        'w1',
      ),
      new AIMessage('What brings you to Lisbon?'),
    );
    await t.say('Lisbon');
    expect((await t.state()).next).toEqual([]);
    const result = t.intakeModel.calls[1].messages.find(
      (m) => ToolMessage.isInstance(m) && m.tool_call_id === 'w1',
    );
    expect(result?.content).toBe(NOT_SHOWN);
    expect(t.drafts).toHaveLength(0);
  });

  it('gives up after two invalid widgets in a row', async () => {
    const t = setup();
    const bad = { destination: 'Lisbon', purpose: 'tbd' };
    t.intakeModel.push(
      callTool('present_brief', bad),
      callTool('present_brief', bad),
    );
    const result = await t.say('Lisbon');
    expect(t.intakeModel.calls).toHaveLength(2);
    expect(result.messages.at(-1)?.content).toBe(INTAKE_FALLBACK_LINE);
  });

  it('searches, then answers', async () => {
    const t = setup();
    t.intake.briefConfirmed = 'yes';
    t.plannerModel.push(
      callTool('web_search', { query: 'Lisbon events June 2027' }),
      new AIMessage('The Santo António festival.'),
    );
    await t.say('Anything on in June?');
    expect(t.search).toHaveBeenCalledTimes(1);
    expect(t.plannerModel.calls[0].options).toEqual({});
  });

  it('stops offering search after three in one reply', async () => {
    const t = setup();
    t.intake.briefConfirmed = 'yes';
    t.plannerModel.push(
      callTool('web_search', { query: 'one' }),
      callTool('web_search', { query: 'two' }),
      callTool('web_search', { query: 'three' }),
      new AIMessage('Done.'),
    );
    await t.say('Research everything');
    expect(t.plannerModel.calls).toHaveLength(4);
    expect(t.plannerModel.calls[3].tools).toEqual(['web_search']);
    expect(t.plannerModel.calls[3].options).toEqual({ tool_choice: 'none' });
  });

  it('recovers from a Stop during a search: the cancelled call is answered in place', async () => {
    const t = setup();
    t.intake.briefConfirmed = 'yes';
    const abort = new AbortController();
    t.plannerModel.push(callTool('web_search', { query: 'slow' }, 's1'));
    t.search.mockImplementationOnce(async () => {
      abort.abort();
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('aborted');
    });
    await expect(t.say('Anything on?', abort.signal)).rejects.toThrow();

    t.plannerModel.push(new AIMessage('Here you go.'));
    await t.say('Never mind, just plan it');
    const sent = t.plannerModel.calls.at(-1)!.messages;
    const callIndex = sent.findIndex(
      (m) => AIMessage.isInstance(m) && m.tool_calls?.[0]?.id === 's1',
    );
    expect(callIndex).toBeGreaterThan(-1);
    const next = sent[callIndex + 1] as ToolMessage;
    expect(ToolMessage.isInstance(next) && next.content).toBe(CANCELLED_RESULT);
    expect(sent.at(-1)?.content).toBe('Never mind, just plan it');
  });
});
