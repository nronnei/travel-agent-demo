import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntakeHeader } from '@travel-agent/shared';
import type { ChatRequest } from './chat.schema.js';

/**
 * Forwards chat turns to the Inkeep run API (/run/api/chat), which streams back
 * the Vercel AI SDK UI message stream that `useChat` consumes.
 *
 * Authenticates with the run API bypass secret plus explicit tenant/project/agent
 * headers, so the secret never leaves the server.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly config: ConfigService) {}

  async stream(body: ChatRequest, signal: AbortSignal): Promise<Readable> {
    const baseUrl = this.config.get<string>('INKEEP_AGENTS_API_URL');
    const secret = this.config.get<string>(
      'INKEEP_AGENTS_RUN_API_BYPASS_SECRET',
    );
    if (!baseUrl || !secret) {
      throw new ServiceUnavailableException('Chat is not configured');
    }

    const conversationId = body.conversationId ?? body.id;
    const res = await fetch(new URL('/run/api/chat', baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-inkeep-tenant-id': this.config.get('INKEEP_TENANT_ID', 'default'),
        'x-inkeep-project-id': this.config.get(
          'INKEEP_PROJECT_ID',
          'travel-agent',
        ),
        'x-inkeep-agent-id': this.config.get('INKEEP_AGENT_ID', 'travel-agent'),
        // Validated by the agent's context config and forwarded by its context
        // fetcher, which calls back to /api/intake/:id/context for the intake.
        ...(conversationId && { [IntakeHeader.ConversationId]: conversationId }),
        [IntakeHeader.Token]: this.config.get('INTAKE_API_TOKEN', ''),
      },
      // Inkeep only reads the latest user message and loads prior turns from its
      // own store by conversationId, so useChat's chat id must be passed through.
      body: JSON.stringify({
        ...body,
        conversationId,
      }),
    }).catch((err: unknown) => {
      if (signal.aborted) throw err;
      this.logger.error(`Inkeep unreachable: ${String(err)}`);
      throw new BadGatewayException('Agent service unreachable');
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Inkeep responded ${res.status}: ${detail}`);
      throw new BadGatewayException(`Agent service error (${res.status})`);
    }
    // fetch's web stream is typed against DOM lib; it is Node's implementation at runtime.
    return Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
  }
}
