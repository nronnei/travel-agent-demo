import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  CONVERSATION_KEY_HEADER,
  ConversationIdSchema,
  LangGraphStreamRequestSchema,
  type LangGraphRunRequest,
} from '@travel-agent/shared';
import type { FastifyReply } from 'fastify';
import { pipeSse } from '../common/sse.js';
import { parse } from '../common/validation.js';
import { IntakeService } from '../intake/intake.service.js';
import { LangGraphClient } from './langgraph.client.js';

/**
 * The LangGraph chat: one run per guest turn, streamed back as LangGraph's own
 * run events (values, messages, updates, custom), which the web app reads
 * with `useStream`. Only a guest message or a widget answer gets through: the
 * upstream body is built here, and the thread is the one minted for this claim.
 */
@Controller('langgraph/:conversationId')
export class LangGraphController {
  constructor(
    private readonly intake: IntakeService,
    private readonly client: LangGraphClient,
  ) {}

  @Post('stream')
  @HttpCode(200)
  async stream(
    @Param('conversationId') id: string,
    @Headers(CONVERSATION_KEY_HEADER) key: string | undefined,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const conversationId = parse(ConversationIdSchema, id);
    const record = await this.intake.authorize(conversationId, key);
    const request = parse(LangGraphStreamRequestSchema, body);
    const upstream: LangGraphRunRequest =
      'command' in request
        ? { conversationId, command: { resume: request.command.resume } }
        : { conversationId, input: { messages: request.input.messages } };
    return pipeSse(reply, (signal) =>
      this.client.stream(record.threadId, upstream, signal),
    );
  }
}
