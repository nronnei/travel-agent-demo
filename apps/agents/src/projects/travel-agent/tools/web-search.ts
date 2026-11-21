import { CredentialStoreType } from '@inkeep/agents-core';
import { credential, mcpTool } from '@inkeep/agents-sdk';
import { intakeApiUrl } from '../config';

/**
 * Inkeep's memory credential store reads `SEARCH_API_TOKEN` from the Inkeep
 * server's own env at run time and sends it as `Authorization: Bearer`. The
 * token is never stored in Inkeep's DB. It must match the API's value.
 */
const searchCredential = credential({
  id: 'travel-search-token',
  name: 'Travel search token',
  type: CredentialStoreType.memory,
  credentialStoreId: 'memory-default',
  retrievalParams: { key: 'SEARCH_API_TOKEN' },
});

/**
 * The Nest API's web search, served as an MCP server. Inkeep discovers its
 * `web_search` tool on push, so the API must be running with the token set.
 * Re-push after changing the tool's schema or description.
 */
export const webSearchTool = mcpTool({
  id: 'travel-search',
  name: 'Travel search',
  // Builder metadata only: the model sees the MCP server's tool description
  // (WEB_SEARCH_TOOL_DESCRIPTION in @travel-agent/shared).
  description: 'Web search for travel planning',
  serverUrl: `${intakeApiUrl}/api/mcp`,
  credential: searchCredential,
});
