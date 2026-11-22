/**
 * The travel agent on LangGraph: an explicit graph, gated into intake and
 * planning by the guest's confirmed brief (read from the API on every run, so
 * the hand-off is decided in code, not by the model). Widgets are tool calls
 * that pause the graph with `interrupt()` until the guest answers.
 *
 *   START → loadIntake ─┬→ intakeAgent → prepareWidget → awaitGuest → loadIntake
 *                       │     └→ END         └→ intakeAgent (invalid widget)
 *                       └→ planner ⇄ search
 *                             └→ END
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import {
  BRIEF_CONFIRMED_MESSAGE,
  IntakeComponent,
  WEB_SEARCH_TOOL_NAME,
  WIDGET_NOT_SHOWN_PREFIX,
  WidgetAnswerSchema,
  interestsAnswer,
  type IntakeComponentData,
  type IntakeContext,
  type WidgetAnswer,
} from '@travel-agent/shared';
import type { IntakeClient, SearchClient } from './apiClient.js';
import { flattenToolCalls, repairHistory } from './history.js';
import {
  INTAKE_FALLBACK_LINE,
  MAX_SEARCHES_PER_REPLY,
  intakePrompt,
  plannerPrompt,
} from './prompts.js';
import { webSearchTool } from './tools/webSearch.js';
import {
  PRESENT_BRIEF,
  WIDGET_TOOLS,
  presentBrief,
  suggestInterests,
  widgetFor,
} from './tools/widgets.js';

export const NOT_SHOWN =
  'Not shown: a detail is missing. Ask the guest for it instead of guessing.';
const ONE_AT_A_TIME = 'Not shown: only one widget can be shown at a time.';
/** After this many "Not shown" results in a row, the intake stops trying. */
export const MAX_INVALID_WIDGETS = 2;

/** Model-bearing steps per run; a confirm → plan turn with three searches is about 10. */
export const RECURSION_LIMIT = 16;

export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** The guest's intake record, read from the API at the start of every run. */
  intake: Annotation<IntakeContext | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  /** Widgets shown, by the tool call that produced them. */
  widgets: Annotation<Record<string, IntakeComponentData>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});
export type State = typeof GraphState.State;

/** What the interrupt carries to the browser. */
export interface WidgetInterrupt {
  toolCallId: string;
  widget: IntakeComponentData;
}

export interface GraphDeps {
  models: { intake: BaseChatModel; planner: BaseChatModel };
  intakeClient: IntakeClient;
  searchClient: SearchClient;
  checkpointer: BaseCheckpointSaver;
}

/** The conversation id the API passes alongside the (per-claim) thread id. */
export function conversationIdOf(config: RunnableConfig): string {
  const id = config.configurable?.conversation_id;
  if (typeof id !== 'string' || !id) throw new Error('No conversation id');
  return id;
}

/** A message's text, whether its content is a string or content blocks. */
export const textOf = (content: BaseMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
        .join('');

const lastAi = (messages: readonly BaseMessage[]) =>
  [...messages].reverse().find((m) => AIMessage.isInstance(m));

/** Messages since the guest last spoke (a human message, or a widget answer). */
function sinceGuest(messages: readonly BaseMessage[]): BaseMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const widgetAnswer =
      ToolMessage.isInstance(m) &&
      WIDGET_TOOLS.has(m.name ?? '') &&
      !textOf(m.content).startsWith(WIDGET_NOT_SHOWN_PREFIX);
    if (m.getType() === 'human' || widgetAnswer) return messages.slice(i + 1);
  }
  return [...messages];
}

/** The widget call of the last AI message that hasn't been answered yet. */
function pendingWidgetCall(messages: readonly BaseMessage[]) {
  const ai = lastAi(messages);
  const answered = new Set(
    messages
      .filter((m) => ToolMessage.isInstance(m))
      .map((m) => m.tool_call_id),
  );
  return ai?.tool_calls?.find(
    (c) => c.id && WIDGET_TOOLS.has(c.name) && !answered.has(c.id),
  );
}

/** What the guest's answer tells the intake model, as the tool's result. */
export function parseAnswer(raw: unknown): WidgetAnswer {
  const parsed = WidgetAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : { type: 'reply', text: '(no answer)' };
}

/** The guest's answer in their own words, as the app would have sent it. */
export function guestWords(answer: WidgetAnswer): string {
  if (answer.type === 'interests') return interestsAnswer(answer.labels);
  if (answer.type === 'confirm') return BRIEF_CONFIRMED_MESSAGE;
  return answer.text;
}

export function answerText(
  widget: IntakeComponentData | undefined,
  answer: WidgetAnswer,
): string {
  const fits =
    (answer.type === 'interests' &&
      widget?.name === IntakeComponent.InterestPicker) ||
    (answer.type === 'confirm' && widget?.name === IntakeComponent.TripBrief);
  if (answer.type === 'interests' && fits)
    return answer.labels.length
      ? `The guest picked: ${answer.labels.join(', ')}.`
      : 'The guest picked no interests.';
  if (answer.type === 'confirm' && fits)
    return 'The guest confirmed the brief.';
  return `The guest answered in their own words: ${guestWords(answer)}`;
}

export function buildGraph({
  models,
  intakeClient,
  searchClient,
  checkpointer,
}: GraphDeps) {
  const webSearch = webSearchTool(searchClient);
  const intakeModel = models.intake.bindTools!(
    [suggestInterests, presentBrief],
    {
      // One widget per message; Anthropic's flag for it.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    } as never,
  );

  async function loadIntake(_: State, config: RunnableConfig) {
    return { intake: await intakeClient.context(conversationIdOf(config)) };
  }

  async function intakeAgent(state: State) {
    // Consecutive by construction: any widget answer resets sinceGuest().
    const recent = sinceGuest(state.messages).filter(
      (m) => ToolMessage.isInstance(m) && textOf(m.content) === NOT_SHOWN,
    ).length;
    if (recent >= MAX_INVALID_WIDGETS)
      return { messages: [new AIMessage(INTAKE_FALLBACK_LINE)] };
    const response = await intakeModel.invoke([
      new SystemMessage(intakePrompt(state.intake!)),
      ...repairHistory(state.messages),
    ]);
    return { messages: [response] };
  }

  async function prepareWidget(state: State, config: RunnableConfig) {
    const ai = lastAi(state.messages)!;
    const [call, ...rest] = (ai.tool_calls ?? []).filter((c) => c.id);
    const others = rest.map(
      (c) =>
        new ToolMessage({
          tool_call_id: c.id!,
          name: c.name,
          content: ONE_AT_A_TIME,
        }),
    );
    const widget = call && widgetFor(call.name, call.args);
    if (!call || !widget) {
      return {
        messages: [
          ...(call
            ? [
                new ToolMessage({
                  tool_call_id: call.id!,
                  name: call.name,
                  content: NOT_SHOWN,
                }),
              ]
            : []),
          ...others,
        ],
      };
    }
    if (
      call.name === PRESENT_BRIEF &&
      widget.name === IntakeComponent.TripBrief
    )
      await intakeClient.saveDraft(conversationIdOf(config), widget.props);
    // Checkpointed before awaitGuest interrupts: a node that interrupts re-runs
    // from the top on resume, and loses updates made before the interrupt.
    return { widgets: { [call.id!]: widget }, messages: others };
  }

  function awaitGuest(state: State) {
    const call = pendingWidgetCall(state.messages);
    if (!call) return {};
    const widget = state.widgets[call.id!];
    const answer = parseAnswer(
      interrupt<WidgetInterrupt, unknown>({ toolCallId: call.id!, widget }),
    );
    return {
      messages: [
        new ToolMessage({
          tool_call_id: call.id!,
          name: call.name,
          content: answerText(widget, answer),
        }),
        // The guest's words as a guest turn too: the planner sees widget calls
        // flattened to text without their results (see flattenToolCalls), so
        // this is how it hears "That all looks perfect." and replies at once.
        new HumanMessage(guestWords(answer)),
      ],
    };
  }

  async function planner(state: State) {
    const searches = sinceGuest(state.messages).filter(
      (m) => ToolMessage.isInstance(m) && m.name === WEB_SEARCH_TOOL_NAME,
    ).length;
    const model = models.planner.bindTools!(
      [webSearch],
      searches >= MAX_SEARCHES_PER_REPLY
        ? ({ tool_choice: 'none' } as never)
        : {},
    );
    const response = await model.invoke([
      new SystemMessage(plannerPrompt(state.intake!)),
      ...flattenToolCalls(repairHistory(state.messages), WIDGET_TOOLS),
    ]);
    return { messages: [response] };
  }

  const wantsTool = (state: State, names: Set<string>) =>
    Boolean(
      lastAi(state.messages)?.tool_calls?.some((c) => names.has(c.name)),
    ) && AIMessage.isInstance(state.messages.at(-1));

  return new StateGraph(GraphState)
    .addNode('loadIntake', loadIntake)
    .addNode('intakeAgent', intakeAgent)
    .addNode('prepareWidget', prepareWidget)
    .addNode('awaitGuest', awaitGuest)
    .addNode('planner', planner)
    .addNode('search', new ToolNode([webSearch]))
    .addEdge(START, 'loadIntake')
    .addConditionalEdges(
      'loadIntake',
      (s) => (s.intake?.briefConfirmed === 'yes' ? 'planner' : 'intakeAgent'),
      ['planner', 'intakeAgent'],
    )
    .addConditionalEdges(
      'intakeAgent',
      (s) => (wantsTool(s, WIDGET_TOOLS) ? 'prepareWidget' : END),
      ['prepareWidget', END],
    )
    .addConditionalEdges(
      'prepareWidget',
      (s) => (pendingWidgetCall(s.messages) ? 'awaitGuest' : 'intakeAgent'),
      ['awaitGuest', 'intakeAgent'],
    )
    .addEdge('awaitGuest', 'loadIntake')
    .addConditionalEdges(
      'planner',
      (s) => (wantsTool(s, new Set([WEB_SEARCH_TOOL_NAME])) ? 'search' : END),
      ['search', END],
    )
    .addEdge('search', 'planner')
    .compile({ checkpointer });
}

export type TravelGraph = ReturnType<typeof buildGraph>;
