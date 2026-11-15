import { WEB_SEARCH_TOOL_NAME } from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import { z } from 'zod';

/**
 * A turn's web search activity, as one `data-search` message part. Both
 * engines map their own events onto it, so the chat renders it the same way on
 * either backend. One part per turn aggregates all of that turn's searches:
 * Parlant's start events carry no tool-call id and its results arrive as a
 * batch, so searches aren't paired with their results.
 *
 * Starts, results and failures are tracked by event-derived ids, so applying
 * the same event twice (a replay on reconnect) changes nothing.
 */
export const SearchSourceSchema = z.object({
  title: z.string(),
  url: z.string().url(),
});
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchActivitySchema = z.object({
  /** Parlant trace id, or the Inkeep message id. */
  id: z.string(),
  state: z.enum(['searching', 'done', 'error']),
  queries: z.array(z.string()),
  /** Merged and deduplicated by URL; only http(s). */
  sources: z.array(SearchSourceSchema),
  started: z.array(z.string()),
  finished: z.array(z.string()),
  failed: z.array(z.string()),
});
export type SearchActivity = z.infer<typeof SearchActivitySchema>;

export const SEARCH_PART = 'data-search';
export const MAX_SOURCE_CHIPS = 6;

/**
 * Inkeep's stream: whether to build source chips from the reply's markdown
 * links when it carries no tool parts. Off until a captured Inkeep search turn
 * shows whether MCP tool calls appear in the stream (plan step 8.1).
 */
export const INKEEP_MARKDOWN_SOURCES_FALLBACK = false;

export function emptyActivity(id: string): SearchActivity {
  return {
    id,
    state: 'searching',
    queries: [],
    sources: [],
    started: [],
    finished: [],
    failed: [],
  };
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Valid http(s) sources, merged onto `existing` and deduplicated by URL. */
export function mergeSources(
  existing: SearchSource[],
  added: unknown[],
): SearchSource[] {
  const seen = new Set(existing.map((s) => s.url));
  const merged = [...existing];
  for (const candidate of added) {
    const parsed = SearchSourceSchema.safeParse(candidate);
    if (!parsed.success || !isHttpUrl(parsed.data.url)) continue;
    if (seen.has(parsed.data.url)) continue;
    seen.add(parsed.data.url);
    merged.push({ title: parsed.data.title, url: parsed.data.url });
  }
  return merged;
}

/** `searching` while starts outnumber results; `error` only if every search failed. */
function withState(a: SearchActivity): SearchActivity {
  const done = a.finished.length + a.failed.length;
  const state =
    done < a.started.length
      ? 'searching'
      : a.failed.length > 0 && a.finished.length === 0
        ? 'error'
        : 'done';
  return { ...a, state };
}

export function startSearch(
  a: SearchActivity,
  startId: string,
  query: string | undefined,
): SearchActivity {
  if (a.started.includes(startId)) return a;
  return withState({
    ...a,
    started: [...a.started, startId],
    queries:
      query && !a.queries.includes(query) ? [...a.queries, query] : a.queries,
  });
}

export interface SearchOutcome {
  id: string;
  query?: string;
  sources?: unknown[];
  error?: boolean;
}

export function finishSearch(
  a: SearchActivity,
  outcome: SearchOutcome,
): SearchActivity {
  if (a.finished.includes(outcome.id) || a.failed.includes(outcome.id))
    return a;
  const queries =
    outcome.query && !a.queries.includes(outcome.query)
      ? [...a.queries, outcome.query]
      : a.queries;
  if (outcome.error)
    return withState({ ...a, queries, failed: [...a.failed, outcome.id] });
  return withState({
    ...a,
    queries,
    finished: [...a.finished, outcome.id],
    sources: mergeSources(a.sources, outcome.sources ?? []),
  });
}

/**
 * The turn is over (ready, cancelled, error, or the stream ended): anything
 * still searching settles, `done` if any results came, otherwise `error`.
 * Stops the indicator sticking after a tool exception, timeout or cancel.
 */
export function finalizeSearch(a: SearchActivity): SearchActivity {
  if (a.state !== 'searching') return a;
  return { ...a, state: a.finished.length > 0 ? 'done' : 'error' };
}

/** The chips to show: http(s) only, at most MAX_SOURCE_CHIPS. */
export function sourceChips(a: SearchActivity): SearchSource[] {
  return a.sources.filter((s) => isHttpUrl(s.url)).slice(0, MAX_SOURCE_CHIPS);
}

export function searchPart(a: SearchActivity) {
  return { type: SEARCH_PART, data: a } as const;
}

/** The message's search activity, if it has a valid one. */
export function messageSearch(message: UIMessage): SearchActivity | undefined {
  for (const part of message.parts) {
    if (part.type !== SEARCH_PART) continue;
    const parsed = SearchActivitySchema.safeParse(
      (part as { data: unknown }).data,
    );
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Replaces (or adds) the message's search part. */
export function withSearchPart(
  message: UIMessage,
  a: SearchActivity,
): UIMessage {
  const parts = message.parts.filter((p) => p.type !== SEARCH_PART);
  return { ...message, parts: [...parts, searchPart(a)] };
}

// ---- Parlant ----

const CustomSearchSchema = z.object({
  type: z.literal('web-search'),
  query: z.string().optional(),
});

/** The query of a Parlant `custom` event sent by `web_search` as it starts, if it is one. */
export function parlantSearchStart(
  data: unknown,
): { query?: string } | undefined {
  const parsed = CustomSearchSchema.safeParse(data);
  return parsed.success ? { query: parsed.data.query } : undefined;
}

const ToolSearchSchema = z.object({
  tool_calls: z.array(
    z.object({
      result: z
        .object({
          metadata: z
            .object({
              search: z
                .object({
                  query: z.string().optional(),
                  sources: z.array(z.unknown()).optional(),
                  error: z.boolean().optional(),
                })
                .optional(),
            })
            .loose()
            .nullish(),
        })
        .loose(),
    }),
  ),
});

/** The search outcomes in a Parlant `tool` event (`result.metadata.search`), one per call. */
export function parlantSearchResults(
  eventId: string,
  data: unknown,
): SearchOutcome[] {
  const parsed = ToolSearchSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.tool_calls.flatMap(({ result }, i) => {
    const search = result.metadata?.search;
    return search ? [{ id: `${eventId}:${i}`, ...search }] : [];
  });
}

// ---- Inkeep (AI SDK UI message stream) ----

interface ToolPartLike {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
}

function isSearchToolPart(part: UIMessage['parts'][number]): boolean {
  const p = part as ToolPartLike;
  if (p.type === `tool-${WEB_SEARCH_TOOL_NAME}`) return true;
  // MCP tools may come through namespaced, e.g. "travel-search_web_search".
  return (
    p.type === 'dynamic-tool' &&
    typeof p.toolName === 'string' &&
    p.toolName.endsWith(WEB_SEARCH_TOOL_NAME)
  );
}

const ResultsSchema = z.object({
  query: z.string().optional(),
  results: z.array(z.unknown()),
});

/** Sources from a tool output: the WebSearchResponse JSON, raw or inside MCP `content`. */
export function sourcesFromOutput(output: unknown): unknown[] {
  const candidates: unknown[] = [output];
  if (typeof output === 'string') candidates.push(tryJson(output));
  const content = (output as { content?: unknown } | null)?.content;
  if (Array.isArray(content))
    for (const c of content as { type?: string; text?: unknown }[])
      if (c?.type === 'text' && typeof c.text === 'string')
        candidates.push(tryJson(c.text));
  for (const candidate of candidates) {
    const parsed = ResultsSchema.safeParse(candidate);
    if (parsed.success) return parsed.data.results;
  }
  return [];
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isErrorOutput(output: unknown): boolean {
  return (output as { isError?: unknown } | null)?.isError === true;
}

/** Markdown links (not images) in a reply, as sources. */
export function sourcesFromMarkdown(text: string): SearchSource[] {
  const links = [...text.matchAll(/(?<!!)\[([^\]]+)\]\((\S+?)\)/g)].map(
    ([, title, url]) => ({ title, url }),
  );
  return mergeSources([], links);
}

/**
 * Adds a `data-search` part derived from an Inkeep message's search tool
 * parts. `final` once the message has finished, errored or been stopped, so
 * anything still searching settles.
 */
export function fromAiSdkParts(message: UIMessage, final: boolean): UIMessage {
  if (message.role !== 'assistant') return message;
  let a = emptyActivity(message.id);
  let found = false;
  message.parts.forEach((part, i) => {
    if (!isSearchToolPart(part)) return;
    found = true;
    const p = part as ToolPartLike;
    const id = p.toolCallId ?? `${message.id}:${i}`;
    const query = (p.input as { query?: unknown } | undefined)?.query;
    a = startSearch(a, id, typeof query === 'string' ? query : undefined);
    if (p.state === 'output-error' || isErrorOutput(p.output))
      a = finishSearch(a, { id, error: true });
    else if (p.state === 'output-available')
      a = finishSearch(a, { id, sources: sourcesFromOutput(p.output) });
  });

  if (!found) {
    if (!INKEEP_MARKDOWN_SOURCES_FALLBACK || !final) return message;
    const text = message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const sources = sourcesFromMarkdown(text);
    if (!sources.length) return message;
    a = { ...a, state: 'done', sources };
    return withSearchPart(message, a);
  }
  return withSearchPart(message, final ? finalizeSearch(a) : a);
}
