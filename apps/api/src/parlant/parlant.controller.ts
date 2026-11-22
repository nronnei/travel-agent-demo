import {
  Body,
  Controller,
  Get,
  GoneException,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  CONVERSATION_KEY_HEADER,
  ConversationIdSchema,
} from '@travel-agent/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { pipeSse } from '../common/sse.js';
import { parse } from '../common/validation.js';
import { IntakeService } from '../intake/intake.service.js';
import { ParlantClient } from './parlant.client.js';
import { ParlantService } from './parlant.service.js';

const MessageSchema = z.object({ text: z.string().trim().min(1).max(4000) });
const OffsetSchema = z.coerce.number().int().min(0).optional();
const EventIdSchema = z.string().regex(/^[\w-]{1,64}$/);

/**
 * The Parlant chat, passed through with ownership checks. Parlant's own event
 * model reaches the browser unchanged: guest messages go in as events, and the
 * session's events (status, tool results, streamed messages) come back as SSE.
 */
@Controller('parlant/:conversationId')
export class ParlantController {
  constructor(
    private readonly intake: IntakeService,
    private readonly parlant: ParlantService,
    private readonly client: ParlantClient,
  ) {}

  /** Starts an agent turn. Returns the guest message's event offset. */
  @Post('messages')
  @HttpCode(200)
  async message(
    @Param('conversationId') id: string,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
    @Body() body: unknown,
  ): Promise<{ offset: number }> {
    const { text } = parse(MessageSchema, body);
    const event = await this.inSession(id, key, (session) =>
      this.client.postMessage(session, text),
    );
    return { offset: event.offset };
  }

  @Post('cancel')
  @HttpCode(204)
  async cancel(
    @Param('conversationId') id: string,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
  ): Promise<void> {
    await this.inSession(id, key, (session) => this.client.cancel(session));
  }

  /** The session's events from `min_offset` (or after Last-Event-ID), as SSE. */
  @Get('events')
  async events(
    @Param('conversationId') id: string,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('min_offset') minOffset: unknown,
    @Res() reply: FastifyReply,
  ) {
    const query = { minOffset: parse(OffsetSchema, minOffset), lastEventId };
    return this.inSession(id, key, (session) =>
      pipeSse(reply, (signal) => this.client.events(session, query, signal)),
    );
  }

  /** One event, re-sent as it grows: follows an agent message as it streams. */
  @Get('events/:eventId')
  async event(
    @Param('conversationId') id: string,
    @Param('eventId') eventId: string,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const event = parse(EventIdSchema, eventId);
    return this.inSession(id, key, (session) =>
      pipeSse(reply, (signal) => this.client.event(session, event, signal)),
    );
  }

  /**
   * Runs `use` with the conversation's Parlant session. A session Parlant no
   * longer has (410) is forgotten, so the API stops pointing at it.
   */
  private async inSession<T>(
    id: string,
    key: string | undefined,
    use: (session: string) => Promise<T>,
  ): Promise<T> {
    const conversationId = parse(ConversationIdSchema, id);
    // Only the browser that claimed this conversation may talk in it.
    this.intake.authorize(conversationId, key);
    const session = await this.parlant.sessionFor(conversationId);
    try {
      return await use(session);
    } catch (err) {
      if (err instanceof GoneException) this.parlant.forget(conversationId);
      throw err;
    }
  }
}
