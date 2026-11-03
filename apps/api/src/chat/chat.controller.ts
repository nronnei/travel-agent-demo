import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ChatRequestSchema } from './chat.schema.js';
import { ChatService } from './chat.service.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @HttpCode(200)
  async chat(@Body() body: unknown, @Res() reply: FastifyReply) {
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }

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
