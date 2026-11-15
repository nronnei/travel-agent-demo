import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WebSearchRequestSchema,
} from '@travel-agent/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SearchTokenGuard } from './search-token.guard.js';
import { SearchLimitedException, SearchService } from './search.service.js';

const UNAVAILABLE =
  'Search is unavailable right now. Answer from general knowledge and tell the guest what to verify.';
const LIMITED =
  'The search limit is reached for now. Answer from general knowledge and tell the guest what to verify.';

/**
 * `POST /api/mcp`: the same web search as an MCP server (Streamable HTTP,
 * stateless, plain JSON responses), for the Inkeep agent. A new server and
 * transport per request, as the SDK recommends for stateless mode. The guard
 * runs before the reply is hijacked and before any MCP body handling.
 */
@Controller('mcp')
@UseGuards(SearchTokenGuard)
export class SearchMcpController {
  constructor(private readonly search: SearchService) {}

  @Post()
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const server = this.server();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  @Get()
  @HttpCode(405)
  get() {
    return methodNotAllowed();
  }

  @Delete()
  @HttpCode(405)
  delete() {
    return methodNotAllowed();
  }

  private server(): McpServer {
    const server = new McpServer({ name: 'travel-search', version: '1.0.0' });
    server.registerTool(
      WEB_SEARCH_TOOL_NAME,
      {
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        inputSchema: WebSearchRequestSchema.shape,
      },
      async (args): Promise<CallToolResult> => {
        try {
          const response = await this.search.search(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(response) }],
          };
        } catch (err) {
          const text =
            err instanceof SearchLimitedException
              ? LIMITED
              : err instanceof HttpException &&
                  err.getStatus() === HttpStatus.BAD_REQUEST
                ? 'Invalid search request: give a query of 2 to 300 characters.'
                : UNAVAILABLE;
          return { isError: true, content: [{ type: 'text', text }] };
        }
      },
    );
    return server;
  }
}

function methodNotAllowed() {
  return {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  };
}
