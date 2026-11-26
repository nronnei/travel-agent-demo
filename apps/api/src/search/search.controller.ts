import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  SEARCH_CLIENT_HEADER,
  WebSearchRequestSchema,
  toSearchClient,
  type WebSearchResponse,
} from '@travel-agent/shared';
import { parse } from '../common/validation.js';
import { SearchTokenGuard } from './search-token.guard.js';
import { SearchService } from './search.service.js';

/**
 * `POST /api/search/web`: web search over REST, for Parlant and LangGraph.
 * Callers name themselves in `x-search-client` (a label, not auth).
 */
@Controller('search')
@UseGuards(SearchTokenGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('web')
  @HttpCode(200)
  web(
    @Body() body: unknown,
    @Headers(SEARCH_CLIENT_HEADER) client?: string,
  ): Promise<WebSearchResponse> {
    return this.search.search(
      parse(WebSearchRequestSchema, body),
      toSearchClient(client, 'unknown'),
    );
  }
}
