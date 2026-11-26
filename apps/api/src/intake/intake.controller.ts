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
import { parse, safeEqual } from '../common/validation.js';
import { IntakeService } from './intake.service.js';

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
  async setIdentity(
    @Param('conversationId') id: string,
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key?: string,
  ): Promise<{ conversationKey?: string }> {
    return this.intake.setIdentity(
      conversationId(id),
      parse(GuestIdentitySchema, body),
      key,
    );
  }

  /** Called by the web app when the guest confirms their trip brief. */
  @Put('trip')
  async confirmTrip(
    @Param('conversationId') id: string,
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key?: string,
  ): Promise<IntakeContext> {
    return this.intake.confirmTrip(
      conversationId(id),
      parse(TripBriefPropsSchema, body),
      key,
    );
  }

  /**
   * Stores an unconfirmed brief, for the Parlant agent to read back. Written by
   * the web app (conversation key) when the guest edits the brief, and by the
   * Parlant agent's tool (intake token) when it shows one.
   */
  @Put('draft')
  async saveDraft(
    @Param('conversationId') id: string,
    @Body() body: unknown,
    @Headers(CONVERSATION_KEY_HEADER) key?: string,
    @Headers(IntakeHeader.Token) token?: string,
  ): Promise<IntakeContext> {
    const cid = conversationId(id);
    if (token !== undefined) this.checkToken(token);
    else await this.intake.authorize(cid, key);
    return this.intake.saveDraft(cid, parse(TripBriefPropsSchema, body));
  }

  /**
   * Called by the agents on every turn (Inkeep's context fetcher, Parlant's
   * guest-brief variable). Guarded by a shared token since it returns the
   * guest's details.
   */
  @Get('context')
  async context(
    @Param('conversationId') id: string,
    @Headers(IntakeHeader.Token) token: string | undefined,
  ): Promise<IntakeContext> {
    this.checkToken(token);
    return this.intake.context(conversationId(id));
  }

  private checkToken(token: string | undefined) {
    const expected = this.config.get<string>('INTAKE_API_TOKEN');
    if (!expected)
      throw new ServiceUnavailableException('Intake is not configured');
    if (!token || !safeEqual(token, expected))
      throw new UnauthorizedException();
  }
}
