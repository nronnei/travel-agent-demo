import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { safeEqual } from '../common/validation.js';

/**
 * Checks `Authorization: Bearer <SEARCH_API_TOKEN>`. This is deliberately not
 * intake's `x-intake-token` header: Inkeep's credential stuffer always sends
 * credentials as `Authorization: Bearer <value>`. Fails closed (503) when the
 * token isn't configured.
 */
@Injectable()
export class SearchTokenGuard implements CanActivate {
  private readonly logger = new Logger('Search');

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const expected = this.config.get<string>('SEARCH_API_TOKEN');
    if (!expected) {
      this.logger.warn(
        `search rejected status=503 path=${req.routeOptions?.url ?? ''}`,
      );
      throw new ServiceUnavailableException('Web search is not configured');
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
    if (!token || !safeEqual(token, expected)) {
      this.logger.warn(
        `search rejected status=401 path=${req.routeOptions?.url ?? ''}`,
      );
      throw new UnauthorizedException();
    }
    return true;
  }
}
