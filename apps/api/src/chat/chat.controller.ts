import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import { CONVERSATION_KEY_HEADER } from '@travel-agent/shared';
import type { FastifyReply } from 'fastify';
import { IntakeService } from '../intake/intake.service.js';
import { ChatRequestSchema } from './chat.schema.js';
import { ChatService } from './chat.service.js';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly intake: IntakeService,
  ) {}

  @Post()
  @HttpCode(200)
  async chat(
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    // Only the browser that claimed this conversation (by storing the guest's
    // identity) may talk in it: its history and intake are the guest's.
    this.intake.authorize(parsed.data.id, key);

    // Stop the agent run if the browser goes away (tab closed, stop button).
    // Listen on the response: the request's 'close' fires as soon as its body is read.
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    const stream = await this.chatService.stream(parsed.data, abort.signal);

    return (
      reply
        .header('content-type', 'text/event-stream')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-vercel-ai-ui-message-stream', 'v1')
        // Tell nginx (web container / ingress) not to buffer the SSE stream.
        .header('x-accel-buffering', 'no')
        .send(stream)
    );
  }
}
