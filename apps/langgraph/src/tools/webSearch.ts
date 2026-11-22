import { tool } from '@langchain/core/tools';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import {
  WEB_SEARCH_EVENT_TYPE,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
} from '@travel-agent/shared';
import { z } from 'zod';
import type { SearchClient } from '../apiClient.js';

export const SEARCH_UNAVAILABLE =
  'Search is unavailable right now. Answer from general knowledge and tell the guest what to verify.';

/** What the browser reads from the ToolMessage artifact; the model never sees it. */
export interface SearchArtifact {
  search: {
    query: string;
    sources?: { title: string; url: string }[];
    error?: true;
  };
}

/**
 * Web search through the Nest API. Emits a `web-search` custom event as it
 * starts, so the app can say "Searching the web…" before the result arrives.
 * Never throws: any failure returns the fallback and the turn carries on.
 */
export function webSearchTool(client: SearchClient) {
  return tool(
    async (
      { query, max_results, recency_days },
      config,
    ): Promise<[string, SearchArtifact]> => {
      try {
        (config as LangGraphRunnableConfig | undefined)?.writer?.({
          type: WEB_SEARCH_EVENT_TYPE,
          state: 'searching',
          query,
        });
        const response = await client.search({
          query,
          maxResults: Math.max(1, Math.min(8, max_results ?? 5)),
          ...(recency_days ? { recencyDays: recency_days } : {}),
        });
        return [
          JSON.stringify(response),
          {
            search: {
              query,
              sources: response.results.map(({ title, url }) => ({
                title,
                url,
              })),
            },
          },
        ];
      } catch (err) {
        console.warn(
          `web_search failed: ${err instanceof Error ? err.name : 'error'}`,
        );
        return [SEARCH_UNAVAILABLE, { search: { query, error: true } }];
      }
    },
    {
      name: WEB_SEARCH_TOOL_NAME,
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      responseFormat: 'content_and_artifact',
      schema: z.object({
        query: z
          .string()
          .describe(
            'What to look up, with the destination and dates, e.g. "Lisbon events 12-18 June 2027"',
          ),
        max_results: z
          .number()
          .int()
          .optional()
          .describe('1 to 8 results. Defaults to 5.'),
        recency_days: z
          .number()
          .int()
          .optional()
          .describe(
            'Only results published in the last N days, for news-like questions',
          ),
      }),
    },
  );
}
