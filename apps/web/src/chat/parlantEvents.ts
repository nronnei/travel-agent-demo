import {
  IntakeComponentDataSchema,
  type IntakeComponentData,
} from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import { z } from 'zod';
import {
  emptyActivity,
  finalizeSearch,
  finishSearch,
  parlantSearchResults,
  parlantSearchStart,
  searchPart,
  startSearch,
  withSearchPart,
  type SearchActivity,
} from './searchActivity';

/**
 * Parlant session events, as the API passes them through (Parlant 4.0.5's
 * EventDTO). Only the fields the chat uses are checked.
 */
export const ParlantEventSchema = z.object({
  id: z.string(),
  offset: z.number(),
  kind: z.enum(['message', 'tool', 'status', 'custom']),
  source: z.string(),
  trace_id: z.string(),
  data: z.unknown(),
});
export type ParlantEvent = z.infer<typeof ParlantEventSchema>;

const MessageDataSchema = z.object({
  message: z.string(),
  /** Present while streaming; complete once it ends in null. */
  chunks: z.array(z.string().nullable()).optional(),
});

const StatusDataSchema = z.object({
  status: z.enum([
    'acknowledged',
    'cancelled',
    'processing',
    'ready',
    'typing',
    'error',
  ]),
  /** A stage label, a tool's narration, or (with `chunks`) the model's reasoning. */
  message: z.string().optional(),
  chunks: z.array(z.string().nullable()).optional(),
});

/** Parlant's own stage labels, worded for the guest. */
const STAGE_LABELS: Record<string, string> = {
  Thinking: 'Thinking…',
  'Evaluating tools': 'Working on it…',
  'Running tools': 'Working on it…',
  'Reviewing tool use': 'Working on it…',
  'Compacting session': 'Thinking…',
};

/** The longest tool narration shown as is. */
const MAX_ACTIVITY_LENGTH = 80;

/**
 * What the agent is doing, for the typing indicator. Reasoning is never shown,
 * only that the agent is thinking.
 */
export function activityLabel(
  data: z.infer<typeof StatusDataSchema>,
): string | undefined {
  if (data.chunks) return STAGE_LABELS.Thinking;
  const message = data.message?.trim();
  if (!message) return undefined;
  if (message in STAGE_LABELS) return STAGE_LABELS[message];
  // Anything else is a tool's narration, written for the guest.
  return message.length <= MAX_ACTIVITY_LENGTH && !message.includes('\n')
    ? message
    : undefined;
}

const ToolDataSchema = z.object({
  tool_calls: z.array(
    z.object({
      result: z.object({ metadata: z.unknown().optional() }).loose(),
    }),
  ),
});

const WidgetMetadataSchema = z.object({ widget: z.unknown() });

/**
 * The chat as seen through the session's events. Messages are AI SDK
 * UIMessages so the shared chat screen renders them like Inkeep's.
 */
export interface ParlantChatState {
  messages: UIMessage[];
  /** A turn is in progress: the agent acknowledged a message and isn't ready yet. */
  busy: boolean;
  /** Parlant says the agent is composing a reply. */
  typing: boolean;
  /** What the agent is doing before it replies (see `activityLabel`). */
  activity?: string;
  /** Agent messages still streaming (event ids), to follow until complete. */
  streaming: string[];
  /** Widgets from tool results waiting for their turn's message, by trace id. */
  widgets: Record<string, IntakeComponentData[]>;
  /** Each turn's web search activity, by trace id. */
  searches: Record<string, SearchActivity>;
  /** The id of each turn's first agent message, by trace id: it carries the search part. */
  turnMessages: Record<string, string>;
  /** The highest event offset applied, to resume from. */
  offset: number;
}

export const initialParlantState: ParlantChatState = {
  messages: [],
  busy: false,
  typing: false,
  streaming: [],
  widgets: {},
  searches: {},
  turnMessages: {},
  offset: -1,
};

const componentPart = (data: IntakeComponentData) => ({
  type: 'data-component' as const,
  data,
});

const messageId = (event: ParlantEvent) => `parlant-${event.id}`;
const searchPlaceholderId = (traceId: string) => `parlant-search-${traceId}`;

/**
 * Stores a turn's search activity and shows it: on the turn's first agent
 * message if it has arrived, otherwise on a placeholder assistant message that
 * the first message later replaces.
 */
function withSearch(
  state: ParlantChatState,
  traceId: string,
  activity: SearchActivity,
): ParlantChatState {
  const target = state.turnMessages[traceId] ?? searchPlaceholderId(traceId);
  const exists = state.messages.some((m) => m.id === target);
  return {
    ...state,
    searches: { ...state.searches, [traceId]: activity },
    messages: exists
      ? state.messages.map((m) =>
          m.id === target ? withSearchPart(m, activity) : m,
        )
      : [
          ...state.messages,
          { id: target, role: 'assistant', parts: [searchPart(activity)] },
        ],
  };
}

/** The turn ended: settle a search still showing as in progress. */
function settleSearch(
  state: ParlantChatState,
  traceId: string,
): ParlantChatState {
  const activity = state.searches[traceId];
  if (!activity || activity.state !== 'searching') return state;
  return withSearch(state, traceId, finalizeSearch(activity));
}

/**
 * Widgets are tool-result metadata (`metadata.widget = {name, props}`), never
 * seen by the model. Malformed or unknown ones are dropped, as with Inkeep.
 */
export function toolWidgets(data: unknown): IntakeComponentData[] {
  const parsed = ToolDataSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.tool_calls.flatMap(({ result }) => {
    const meta = WidgetMetadataSchema.safeParse(result.metadata);
    if (!meta.success) return [];
    const widget = IntakeComponentDataSchema.safeParse(meta.data.widget);
    return widget.success ? [widget.data] : [];
  });
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  const { [key]: _, ...rest } = record;
  return rest;
}

/** Adds a turn's waiting widgets as their own message (a turn with no text). */
function flushWidgets(
  state: ParlantChatState,
  traceId: string,
): ParlantChatState {
  const widgets = state.widgets[traceId];
  if (!widgets?.length) return state;
  return {
    ...state,
    widgets: withoutKey(state.widgets, traceId),
    messages: [
      ...state.messages,
      {
        id: `parlant-widgets-${traceId}`,
        role: 'assistant',
        parts: widgets.map(componentPart),
      },
    ],
  };
}

/** Applies one session event (or an update of one) to the chat. Pure. */
export function applyParlantEvent(
  state: ParlantChatState,
  event: ParlantEvent,
): ParlantChatState {
  const next = { ...state, offset: Math.max(state.offset, event.offset) };

  if (event.kind === 'status') {
    const parsed = StatusDataSchema.safeParse(event.data);
    if (!parsed.success) return next;
    switch (parsed.data.status) {
      case 'acknowledged':
        return { ...next, busy: true };
      case 'processing':
        return {
          ...next,
          busy: true,
          activity: activityLabel(parsed.data) ?? next.activity,
        };
      case 'typing':
        return { ...next, busy: true, typing: true, activity: undefined };
      case 'ready':
      case 'cancelled':
        return {
          ...flushWidgets(settleSearch(next, event.trace_id), event.trace_id),
          busy: false,
          typing: false,
          activity: undefined,
        };
      case 'error': {
        const ended = flushWidgets(
          settleSearch(next, event.trace_id),
          event.trace_id,
        );
        return {
          ...ended,
          busy: false,
          typing: false,
          activity: undefined,
          messages: [
            ...ended.messages,
            {
              id: `parlant-error-${event.id}`,
              role: 'assistant',
              parts: [
                {
                  type: 'data-operation',
                  data: {
                    type: 'error',
                    message: 'The agent ran into an error.',
                  },
                },
              ],
            },
          ],
        };
      }
    }
  }

  if (event.kind === 'custom') {
    const start = parlantSearchStart(event.data);
    if (!start) return next;
    const activity =
      next.searches[event.trace_id] ?? emptyActivity(event.trace_id);
    return withSearch(
      next,
      event.trace_id,
      startSearch(activity, event.id, start.query),
    );
  }

  if (event.kind === 'tool') {
    let updated = next;
    const outcomes = parlantSearchResults(event.id, event.data);
    if (outcomes.length) {
      const activity = outcomes.reduce(
        finishSearch,
        next.searches[event.trace_id] ?? emptyActivity(event.trace_id),
      );
      updated = withSearch(next, event.trace_id, activity);
    }
    const widgets = toolWidgets(event.data);
    if (!widgets.length) return updated;
    return {
      ...updated,
      widgets: {
        ...updated.widgets,
        [event.trace_id]: [
          ...(updated.widgets[event.trace_id] ?? []),
          ...widgets,
        ],
      },
    };
  }

  // The guest's own messages are already on screen; only the agent's are added.
  if (event.kind !== 'message' || event.source !== 'ai_agent') return next;
  const parsed = MessageDataSchema.safeParse(event.data);
  if (!parsed.success) return next;
  const { message, chunks } = parsed.data;
  const complete = !chunks || chunks.at(-1) === null;
  const id = messageId(event);
  const streaming = complete
    ? next.streaming.filter((s) => s !== event.id)
    : next.streaming.includes(event.id)
      ? next.streaming
      : [...next.streaming, event.id];

  const existing = next.messages.find((m) => m.id === id);
  if (existing) {
    // A streamed message grew: replace its text, keep its widgets.
    return {
      ...next,
      streaming,
      messages: next.messages.map((m) =>
        m === existing
          ? {
              ...m,
              parts: [
                { type: 'text', text: message },
                ...m.parts.filter((p) => p.type !== 'text'),
              ],
            }
          : m,
      ),
    };
  }
  // A new message carries any widgets its turn's tools already produced. The
  // turn's first message also takes over its search activity, replacing the
  // placeholder that showed it until now.
  const widgets = next.widgets[event.trace_id] ?? [];
  const firstOfTurn = !next.turnMessages[event.trace_id];
  const search = firstOfTurn ? next.searches[event.trace_id] : undefined;
  const placeholder = searchPlaceholderId(event.trace_id);
  return {
    ...next,
    streaming,
    widgets: withoutKey(next.widgets, event.trace_id),
    turnMessages: firstOfTurn
      ? { ...next.turnMessages, [event.trace_id]: id }
      : next.turnMessages,
    messages: [
      ...next.messages.filter((m) => !search || m.id !== placeholder),
      {
        id,
        role: 'assistant',
        parts: [
          { type: 'text', text: message },
          ...widgets.map(componentPart),
          ...(search ? [searchPart(search)] : []),
        ],
      },
    ],
  };
}
