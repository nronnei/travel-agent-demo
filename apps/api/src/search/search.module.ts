import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchMcpController } from './search.mcp.controller.js';
import { SearchController } from './search.controller.js';
import {
  SEARCH_PROVIDER,
  SearchProviderNames,
  offProvider,
  type SearchProvider,
  type SearchProviderName,
} from './search.provider.js';
import { SearchService } from './search.service.js';
import { SearchTokenGuard } from './search-token.guard.js';
import { TavilyProvider } from './tavily.provider.js';

/**
 * `SEARCH_PROVIDER` is `tavily` or `off`; it defaults to `tavily` when
 * `TAVILY_API_KEY` is set. `off` keeps the endpoints up (MCP tool discovery
 * still works) but every search returns 503, so both agents fall back.
 */
export function searchProvider(config: ConfigService): SearchProvider {
  const key = config.get<string>('TAVILY_API_KEY') || undefined;
  const raw = config.get<string>('SEARCH_PROVIDER') || (key ? 'tavily' : 'off');
  const name = SearchProviderNames.includes(raw as SearchProviderName)
    ? (raw as SearchProviderName)
    : undefined;
  const logger = new Logger('Search');
  if (!name) {
    logger.warn(`Unknown SEARCH_PROVIDER "${raw}"; web search is off`);
    return offProvider;
  }
  if (name === 'tavily' && !key) {
    logger.warn(
      'SEARCH_PROVIDER=tavily but TAVILY_API_KEY is unset; web search is off',
    );
    return offProvider;
  }
  logger.log(`Web search provider: ${name}`);
  return name === 'tavily' && key ? new TavilyProvider(key) : offProvider;
}

@Module({
  controllers: [SearchController, SearchMcpController],
  providers: [
    {
      provide: SEARCH_PROVIDER,
      useFactory: searchProvider,
      inject: [ConfigService],
    },
    SearchService,
    SearchTokenGuard,
  ],
})
export class SearchModule {}
