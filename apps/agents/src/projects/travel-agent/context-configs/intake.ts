import { contextConfig, fetchDefinition, headers } from '@inkeep/agents-core';
import {
  IntakeContextSchema,
  IntakeHeader,
  type IntakeContext,
} from '@travel-agent/shared';
import { z } from 'zod';

// The Nest chat proxy adds these to every run request (see apps/api/src/chat).
const intakeHeaders = headers({
  schema: z.object({
    [IntakeHeader.ConversationId]: z.string(),
    [IntakeHeader.Token]: z.string(),
  }),
});

// Where Inkeep reaches the Nest API, as seen from the Inkeep container. Read at push time.
const intakeApiUrl = process.env.INTAKE_API_URL ?? 'http://api:3000';

const intakeFetcher = fetchDefinition({
  id: 'guest-intake',
  name: 'Guest intake',
  // Re-fetch every turn: the brief is confirmed mid-conversation.
  trigger: 'invocation',
  fetchConfig: {
    url: `${intakeApiUrl}/api/intake/${intakeHeaders.toTemplate(IntakeHeader.ConversationId)}/context`,
    method: 'GET',
    headers: {
      [IntakeHeader.Token]: intakeHeaders.toTemplate(IntakeHeader.Token),
    },
    timeout: 5000,
  },
  responseSchema: IntakeContextSchema,
});

/**
 * The guest's own name and title, and their confirmed trip brief, read from the
 * API on every turn so prompts quote the stored values instead of the model's
 * recollection of the conversation.
 */
export const intakeContext = contextConfig({
  id: 'guest-intake',
  headers: intakeHeaders,
  contextVariables: {
    intake: intakeFetcher,
  },
});

/** `{{intake.<field>}}` template for a prompt. */
export const intake = (field: keyof IntakeContext) =>
  intakeContext.toTemplate(`intake.${field}`);
