import { z } from 'zod';

/**
 * Trip intake, shared by the web app, the Nest API and the agent definitions.
 *
 * Exact details (name, title) are typed by the guest into the web app and
 * stored by the API; fuzzy ones (destination, purpose, interests) are drafted
 * by the intake agent and confirmed by the guest. Agents never author the
 * canonical values: they read them back through an Inkeep context fetcher.
 */

/** Data component names, as the agent emits them (or the web app renders locally). */
export const IntakeComponent = {
  /** Rendered locally by the web app during the scripted title step. */
  PrefixPicker: 'PrefixPicker',
  InterestPicker: 'InterestPicker',
  TripBrief: 'TripBrief',
} as const;

// ---- Identity (typed by the guest, never by a model) ----

export const NAME_PREFIXES = ['Mr', 'Ms', 'Mrs', 'Mx', 'Dr', 'none'] as const;
export type NamePrefix = (typeof NAME_PREFIXES)[number];

export const NAME_PREFIX_LABELS: Record<NamePrefix, string> = {
  Mr: 'Mr',
  Ms: 'Ms',
  Mrs: 'Mrs',
  Mx: 'Mx',
  Dr: 'Dr',
  none: 'No title',
};

export const GuestIdentitySchema = z.object({
  givenName: z.string().trim().min(1).max(100),
  /** Optional: some guests have a single name. */
  surname: z.string().trim().max(100).default(''),
  prefix: z.enum(NAME_PREFIXES),
});
export type GuestIdentity = z.infer<typeof GuestIdentitySchema>;

export function fullName({
  givenName,
  surname,
}: Pick<GuestIdentity, 'givenName' | 'surname'>): string {
  return [givenName, surname].filter(Boolean).join(' ');
}

/**
 * How a guest is addressed under the concierge formality rules: title and
 * surname ("Dr García Márquez"), or their full name when they chose no title
 * or gave no surname.
 */
export function formalAddress(identity: GuestIdentity): string {
  if (identity.prefix === 'none' || !identity.surname)
    return fullName(identity);
  return `${identity.prefix} ${identity.surname}`;
}

// ---- Trip details (drafted by the intake agent, confirmed by the guest) ----

/** The curated interests every picker offers; the agent may add a few destination-specific extras. */
export const BASE_INTERESTS = [
  { id: 'food-drink', label: 'Food & drink' },
  { id: 'culture-history', label: 'Culture & history' },
  { id: 'art-museums', label: 'Art & museums' },
  { id: 'outdoors-nature', label: 'Outdoors & nature' },
  { id: 'adventure-sport', label: 'Adventure & sport' },
  { id: 'relaxation-wellness', label: 'Relaxation & wellness' },
  { id: 'beaches', label: 'Beaches' },
  { id: 'nightlife', label: 'Nightlife' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'family-activities', label: 'Family activities' },
] as const;

export const MAX_EXTRA_INTERESTS = 3;

// The agent-facing schemas carry a description on every field: Inkeep shows them
// to the model and rejects data components with undescribed properties.

export const InterestOptionSchema = z
  .object({
    id: z.string().min(1).describe('kebab-case id, e.g. "onsen"'),
    label: z
      .string()
      .min(1)
      .describe('Short display label, e.g. "Onsen & hot springs"'),
  })
  .describe('A destination-specific interest');
export type InterestOption = z.infer<typeof InterestOptionSchema>;

/** Rendered only by the web app (scripted title step), so not described for a model. */
export const PrefixPickerPropsSchema = z.object({
  prompt: z.string().min(1),
});
export type PrefixPickerProps = z.infer<typeof PrefixPickerPropsSchema>;

export const InterestPickerPropsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'One short sentence shown above the options, e.g. "What should your time in Japan focus on?"',
    ),
  extras: z
    .array(InterestOptionSchema)
    .max(MAX_EXTRA_INTERESTS)
    .default([])
    .describe(
      `0 to ${MAX_EXTRA_INTERESTS} interests specific to this destination that the standard list does not already cover.`,
    ),
  /** Pre-selected labels; set only by the web app when the guest edits their brief. */
  selected: z
    .array(z.string())
    .default([])
    .describe('Labels shown as already selected'),
});
export type InterestPickerProps = z.infer<typeof InterestPickerPropsSchema>;

/** What the intake agent may fill in: the picker without the web-only `selected`. */
export const AgentInterestPickerPropsSchema = InterestPickerPropsSchema.omit({
  selected: true,
});

/** Rejects model placeholders like "<UNKNOWN>" or "unknown" in place of a real answer. */
const answered = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (s) => !/^<.*>$/.test(s) && !/^(unknown|n\/a|tbd|none)$/i.test(s),
    'placeholder value',
  );

export const TripBriefPropsSchema = z.object({
  destination: answered.describe(
    'The general destination as the guest gave it, e.g. "Tokyo, Japan", "the Sahara Desert", "New England"',
  ),
  purpose: answered.describe(
    'The purpose as a short noun phrase addressed to the guest, completing "So that\'s ___ in <destination>", e.g. "a relaxing autumn getaway with your partner", "a food tour"',
  ),
  interests: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe('An interest label, exactly as picked'),
    )
    .max(20)
    .default([])
    .describe(
      'Labels of the interests the guest picked, or ones clearly implied by a specific purpose. Empty if none.',
    ),
});
export type TripBriefProps = z.infer<typeof TripBriefPropsSchema>;

/**
 * A `data-component` stream part from Inkeep carries `{ id, name, props }`,
 * where `name` is the data component's name. Parts are validated before
 * rendering, so a malformed component is skipped rather than crashing the chat.
 */
export const IntakeComponentDataSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal(IntakeComponent.PrefixPicker),
    props: PrefixPickerPropsSchema,
  }),
  z.object({
    name: z.literal(IntakeComponent.InterestPicker),
    props: InterestPickerPropsSchema,
  }),
  z.object({
    name: z.literal(IntakeComponent.TripBrief),
    props: TripBriefPropsSchema,
  }),
]);
export type IntakeComponentData = z.infer<typeof IntakeComponentDataSchema>;

// ---- What the agents read back (Inkeep context fetcher response) ----

/**
 * The confirmed intake, as served to Inkeep by the API and templated into the
 * agent prompts. Flat strings so templates stay simple; empty until known.
 */
export const IntakeContextSchema = z.object({
  address: z.string(),
  givenName: z.string(),
  surname: z.string(),
  prefix: z.string(),
  destination: z.string(),
  purpose: z.string(),
  interests: z.string(),
  /** "yes" once the guest has confirmed the trip brief. */
  briefConfirmed: z.enum(['yes', 'no']),
});
export type IntakeContext = z.infer<typeof IntakeContextSchema>;

export function intakeContext(
  identity?: GuestIdentity,
  trip?: TripBriefProps,
): IntakeContext {
  return {
    address: identity ? formalAddress(identity) : '',
    givenName: identity?.givenName ?? '',
    surname: identity?.surname ?? '',
    prefix: identity?.prefix ?? '',
    destination: trip?.destination ?? '',
    purpose: trip?.purpose ?? '',
    interests: trip?.interests.join(', ') ?? '',
    briefConfirmed: trip ? 'yes' : 'no',
  };
}

/** Request headers the Nest chat proxy adds so Inkeep's context fetcher can call back for the intake. */
export const IntakeHeader = {
  ConversationId: 'x-travel-conversation-id',
  Token: 'x-intake-token',
} as const;

// ---- Conversation ownership (browser ↔ API) ----

/** useChat ids are short random strings; anything else is rejected before it becomes a key. */
export const ConversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid conversation id');

/**
 * Proves the browser owns a conversation. Issued once, when the guest's identity
 * is first stored, and required on every later intake and chat request.
 */
export const CONVERSATION_KEY_HEADER = 'x-conversation-key';

/** Response to the first `PUT /api/intake/:id/identity`. */
export const ClaimedConversationSchema = z.object({
  conversationKey: z.string(),
});

/**
 * Prepended (by the API) to the next guest message after they edit the brief
 * themselves, so the intake agent builds on their edits.
 */
export function editedBriefNote(brief: TripBriefProps): string {
  const interests = brief.interests.length
    ? brief.interests.join(', ')
    : 'none';
  return `[I've edited the trip brief myself. It now reads: destination: ${brief.destination}; purpose: ${brief.purpose}; interests: ${interests}.]`;
}

// ---- The scripted conversation (web app) and the messages it sends ----

/** The concierge's opening line, shown by the web app as the first assistant message. */
export const INTAKE_GREETING =
  'Good day, and welcome to our concierge service. I would be delighted to help you plan your next journey. May I have your name?';

export function titleQuestion(givenName: string): string {
  return `Lovely to meet you, ${givenName}. How shall we address you?`;
}

/** The last scripted line before the intake agent takes over. */
export function destinationQuestion(address: string): string {
  return `Thank you, ${address}. Where would you like to travel? A city, a region or a landscape will do nicely, or I can suggest a few if you're undecided.`;
}

export function nameAnswer(
  identity: Pick<GuestIdentity, 'givenName' | 'surname'>,
): string {
  return `I'm ${fullName(identity)}.`;
}

export function prefixAnswer(prefix: NamePrefix): string {
  return prefix === 'none' ? 'Just my name, please.' : `${prefix}, please.`;
}

/** The guest message sent when they pick interests (the intake prompt expects this shape). */
export function interestsAnswer(labels: readonly string[]): string {
  return `I'd like the trip to focus on: ${labels.join(', ')}.`;
}

/** The guest message sent when they confirm the brief (the intake prompt expects this exact text). */
export const BRIEF_CONFIRMED_MESSAGE = 'That all looks perfect.';
