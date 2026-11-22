import { tool } from '@langchain/core/tools';
import {
  AgentInterestPickerPropsSchema,
  BASE_INTERESTS,
  IntakeComponent,
  LANGGRAPH_WIDGET_TOOLS,
  MAX_EXTRA_INTERESTS,
  TripBriefPropsSchema,
  type IntakeComponentData,
} from '@travel-agent/shared';
import { z } from 'zod';

/**
 * The intake's widget tools. They are only definitions for the model: no
 * ToolNode runs them. The graph's `prepareWidget` node turns a call into a
 * widget, and `awaitGuest` pauses on it until the guest answers.
 */

export const [SUGGEST_INTERESTS, PRESENT_BRIEF] = LANGGRAPH_WIDGET_TOOLS;
export const WIDGET_TOOLS = new Set<string>(LANGGRAPH_WIDGET_TOOLS);

const noop = async () => '';

export const suggestInterests = tool(noop, {
  name: SUGGEST_INTERESTS,
  description:
    'Shows the guest the interest picker for their destination. The picker asks its own question and lists the standard interests.',
  schema: z.object({
    destination: z
      .string()
      .describe('The destination as the guest gave it, e.g. "Lisbon"'),
    extras: z
      .array(z.string())
      .describe(
        'Zero to three interests specific to this destination that the standard list (food & drink, culture & history, art & museums, outdoors & nature, adventure & sport, relaxation & wellness, beaches, nightlife, shopping, family activities) misses, e.g. ["Fado music"]',
      ),
  }),
});

export const presentBrief = tool(noop, {
  name: PRESENT_BRIEF,
  description:
    'Shows the guest their trip brief to confirm or change, and saves it as the draft.',
  schema: z.object({
    destination: z
      .string()
      .describe(
        'The general destination as the guest gave it, e.g. "Tokyo, Japan"',
      ),
    purpose: z
      .string()
      .describe(
        'The purpose as a short noun phrase addressed to the guest, completing "So that\'s ___ in <destination>", e.g. "a relaxing autumn getaway with your partner"',
      ),
    interests: z
      .array(z.string())
      .describe(
        'Labels of the interests the guest picked, or ones clearly implied by a specific purpose. Empty if none.',
      ),
  }),
});

export const kebab = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Up to three extras the standard list lacks, as picker options. */
export function interestPickerProps(destination: string, extras: unknown) {
  const base = new Set(BASE_INTERESTS.map((i) => i.label.toLowerCase()));
  const options = (Array.isArray(extras) ? extras : [])
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim())
    .filter((label) => label && !base.has(label.toLowerCase()) && kebab(label))
    .map((label) => ({ id: kebab(label), label }))
    .slice(0, MAX_EXTRA_INTERESTS);
  return AgentInterestPickerPropsSchema.safeParse({
    prompt: `What should your time in ${destination} focus on?`,
    extras: options,
  });
}

/** The widget for a widget tool call, or null when its arguments don't make a valid one. */
export function widgetFor(
  name: string,
  args: Record<string, unknown>,
): IntakeComponentData | null {
  if (name === SUGGEST_INTERESTS) {
    const destination =
      typeof args.destination === 'string' ? args.destination.trim() : '';
    if (!destination) return null;
    const props = interestPickerProps(destination, args.extras);
    return props.success
      ? {
          name: IntakeComponent.InterestPicker,
          props: { ...props.data, selected: [] },
        }
      : null;
  }
  if (name === PRESENT_BRIEF) {
    const props = TripBriefPropsSchema.safeParse(args);
    return props.success
      ? { name: IntakeComponent.TripBrief, props: props.data }
      : null;
  }
  return null;
}
