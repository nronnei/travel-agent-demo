import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LangGraphRunRequest } from '@travel-agent/shared';

/**
 * The LangGraph agent service. Requests carry its service token; the API in
 * front checks conversation ownership. Upstream error bodies are logged, never
 * passed to the browser.
 */
@Injectable()
export class LangGraphClient {
  private readonly logger = new Logger(LangGraphClient.name);

  constructor(private readonly config: ConfigService) {}

  async stream(
    threadId: string,
    body: LangGraphRunRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const baseUrl = this.config.get<string>('LANGGRAPH_API_URL');
    const token = this.config.get<string>('LANGGRAPH_API_TOKEN');
    const missing = [
      !baseUrl && 'LANGGRAPH_API_URL',
      !token && 'LANGGRAPH_API_TOKEN',
    ].filter(Boolean);
    if (missing.length) {
      this.logger.error(
        `LangGraph chat is off: ${missing.join(' and ')} not set`,
      );
      throw new ServiceUnavailableException(
        `Chat is not configured (${missing.join(', ')} missing)`,
      );
    }
    const res = await fetch(
      new URL(`/threads/${encodeURIComponent(threadId)}/stream`, baseUrl),
      {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ).catch((err: unknown) => {
      if (signal.aborted) throw err;
      this.logger.error(`LangGraph unreachable: ${String(err)}`);
      throw new BadGatewayException('Agent service unreachable');
    });
    if (res.ok && res.body) return res;
    const detail = await res.text().catch(() => '');
    this.logger.error(`LangGraph responded ${res.status}: ${detail}`);
    if (res.status === 409)
      throw new ConflictException('A reply is already in progress');
    throw new BadGatewayException(`Agent service error (${res.status})`);
  }
}
