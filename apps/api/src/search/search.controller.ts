import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  WebSearchRequestSchema,
  type WebSearchResponse,
} from '@travel-agent/shared';
import { parse } from '../common/validation.js';
import { SearchTokenGuard } from './search-token.guard.js';
import { SearchService } from './search.service.js';

/** `POST /api/search/web`: web search over REST, for the Parlant agent. */
@Controller('search')
@UseGuards(SearchTokenGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('web')
  @HttpCode(200)
  web(@Body() body: unknown): Promise<WebSearchResponse> {
    return this.search.search(parse(WebSearchRequestSchema, body));
  }
}
