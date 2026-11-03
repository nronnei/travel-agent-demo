import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Put,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONVERSATION_KEY_HEADER,
  ConversationIdSchema,
  GuestIdentitySchema,
  IntakeHeader,
  TripBriefPropsSchema,
  type IntakeContext,
} from '@travel-agent/shared';
import type { z } from 'zod';
import { IntakeService } from './intake.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

function conversationId(id: string): string {
  if (!ConversationIdSchema.safeParse(id).success)
    throw new BadRequestException('Invalid conversation id');
  return id;
}

@Controller('intake/:conversationId')
export class IntakeController {
  constructor(
    private readonly intake: IntakeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Called by the web app once the guest has typed their name and picked a title.
   * The first call for a conversation claims it and returns its key.
   */
  @Put('identity')
  setIdentity(
    @Param('conversationId') id: string,
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key?: string,
  ): { conversationKey?: string } {
    return this.intake.setIdentity(
      conversationId(id),
      parse(GuestIdentitySchema, body),
      key,
    );
  }

  /** Called by the web app when the guest confirms their trip brief. */
  @Put('trip')
  confirmTrip(
    @Param('conversationId') id: string,
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key?: string,
  ): IntakeContext {
    return this.intake.confirmTrip(
      conversationId(id),
      parse(TripBriefPropsSchema, body),
      key,
    );
  }

  /**
   * Called by Inkeep's context fetcher on every agent turn. Guarded by a shared
   * token (forwarded by the chat proxy) since it returns the guest's details.
   */
  @Get('context')
  context(
    @Param('conversationId') id: string,
    @Headers(IntakeHeader.Token) token: string | undefined,
  ): IntakeContext {
    const expected = this.config.get<string>('INTAKE_API_TOKEN');
    if (!expected)
      throw new ServiceUnavailableException('Intake is not configured');
    if (!token || !safeEqual(token, expected))
      throw new UnauthorizedException();
    return this.intake.context(conversationId(id));
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
