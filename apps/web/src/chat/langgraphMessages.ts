import {
  IntakeComponentDataSchema,
  LANGGRAPH_WIDGET_TOOLS,
  WEB_SEARCH_TOOL_NAME,
  WIDGET_NOT_SHOWN_PREFIX,
} from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import {
  emptyActivity,
  finalizeSearch,
  finishSearch,
  searchPart,
  startSearch,
  type SearchActivity,
} from './searchActivity';

/**
 * LangGraph's messages, as `useStream` hands them over (plain dicts in the
 * SDK's format; class instances are read the same way), mapped onto the chat's
 * `UIMessage`s.
 */

interface ToolCallLike {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GraphMessage {
  type?: string;
  id?: string;
  content?: unknown;
  tool_calls?: ToolCallLike[];
  tool_call_id?: string;
  name?: string;
  artifact?: unknown;
  getType?: () => string;
}

const WIDGET_TOOLS = new Set<string>(LANGGRAPH_WIDGET_TOOLS);

const typeOf = (m: GraphMessage) => m.getType?.() ?? m.type ?? '';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/**
 * Where a new agent turn starts: after a guest message, or after the tool
 * result that carries their answer to a widget.
 */
function isGuestBoundary(m: GraphMessage): boolean {
  const type = typeOf(m);
  if (type === 'human') return true;
  return (
    type === 'tool' &&
    WIDGET_TOOLS.has(m.name ?? '') &&
    !textOf(m.content).startsWith(WIDGET_NOT_SHOWN_PREFIX)
  );
}

/** The graph's agent messages, grouped by turn (everything between guest boundaries). */
export function agentTurns(
  messages: readonly GraphMessage[],
): GraphMessage[][] {
  const turns: GraphMessage[][] = [];
  let current: GraphMessage[] = [];
  for (const m of messages) {
    if (isGuestBoundary(m)) {
      if (current.length) turns.push(current);
      current = [];
    } else {
      current.push(m);
    }
  }
  if (current.length) turns.push(current);
  return turns.filter((turn) => turn.some((m) => typeOf(m) === 'ai' && m.id));
}

const SearchArtifactSchema = (artifact: unknown) => {
  const search = (artifact as { search?: unknown } | undefined)?.search;
  if (!search || typeof search !== 'object') return undefined;
  const s = search as { query?: unknown; sources?: unknown; error?: unknown };
  return {
    query: typeof s.query === 'string' ? s.query : undefined,
    sources: Array.isArray(s.sources) ? s.sources : [],
    error: s.error === true,
  };
};

/**
 * One assistant bubble for a turn: its text joined, a `data-component` part
 * for each widget it showed, and one `data-search` part for all its searches
 * (the indicator above the answer, the chips below, as on the other backends).
 */
export function turnMessage(
  turn: readonly GraphMessage[],
  widgets: Record<string, unknown>,
  live: boolean,
): UIMessage {
  const id = turn.find((m) => typeOf(m) === 'ai' && m.id)!.id!;
  const parts: UIMessage['parts'] = [];
  let search: SearchActivity | undefined;
  // Widget calls the agent rejected ("Not shown…"): their line ("Here is your
  // trip brief.") would introduce a widget that never appears.
  const notShown = new Set(
    turn
      .filter(
        (m) =>
          typeOf(m) === 'tool' &&
          textOf(m.content).startsWith(WIDGET_NOT_SHOWN_PREFIX),
      )
      .map((m) => m.tool_call_id),
  );
  for (const m of turn) {
    const type = typeOf(m);
    if (type === 'ai') {
      const calls = (m.tool_calls ?? []).filter((c) => c.id);
      const rejected =
        calls.length > 0 && calls.every((c) => notShown.has(c.id));
      const text = rejected ? '' : textOf(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const call of m.tool_calls ?? []) {
        if (!call.id) continue;
        if (WIDGET_TOOLS.has(call.name)) {
          const widget = IntakeComponentDataSchema.safeParse(widgets[call.id]);
          if (widget.success)
            parts.push({ type: 'data-component', data: widget.data });
        } else if (call.name === WEB_SEARCH_TOOL_NAME) {
          const query = call.args?.query;
          search = startSearch(
            search ?? emptyActivity(id),
            call.id,
            typeof query === 'string' ? query : undefined,
          );
        }
      }
    } else if (
      type === 'tool' &&
      m.name === WEB_SEARCH_TOOL_NAME &&
      m.tool_call_id
    ) {
      const outcome = SearchArtifactSchema(m.artifact);
      search = finishSearch(search ?? emptyActivity(id), {
        id: m.tool_call_id,
        query: outcome?.query,
        sources: outcome?.sources ?? [],
        error: outcome ? outcome.error : true,
      });
    }
  }
  if (search) parts.push(searchPart(live ? search : finalizeSearch(search)));
  return { id, role: 'assistant', parts };
}

/**
 * Merges the graph's turns into the chat's messages: a turn already shown is
 * replaced in place (so a streaming copy and its final copy never both show),
 * and a new one is appended. Guest messages and scripted lines are kept as
 * they are: the engine adds the guest's bubble when they send.
 */
export function mergeGraphMessages(
  current: readonly UIMessage[],
  graphMessages: readonly GraphMessage[],
  widgets: Record<string, unknown> = {},
  loading = false,
): UIMessage[] {
  const turns = agentTurns(graphMessages);
  const next = [...current];
  turns.forEach((turn, i) => {
    const message = turnMessage(
      turn,
      widgets,
      loading && i === turns.length - 1,
    );
    const at = next.findIndex((m) => m.id === message.id);
    if (at >= 0) next[at] = message;
    else next.push(message);
  });
  return next;
}
