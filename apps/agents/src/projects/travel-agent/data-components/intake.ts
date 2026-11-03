import { dataComponent } from '@inkeep/agents-sdk';
import {
  AgentInterestPickerPropsSchema,
  BASE_INTERESTS,
  IntakeComponent,
  MAX_EXTRA_INTERESTS,
  TripBriefPropsSchema,
} from '@travel-agent/shared';

// Props schemas come from @travel-agent/shared, so the agent, the web app and
// the API validate the same shapes.
//
// There is no name/title component: the web app collects those itself and the
// agents read them back from the intake context, so no model ever retypes them.

export const interestPicker = dataComponent({
  id: 'interest-picker',
  name: IntakeComponent.InterestPicker,
  description: `Shows the guest a multi-select list of trip interests. The app always shows the standard interests (${BASE_INTERESTS.map((i) => i.label).join(', ')}); you only supply up to ${MAX_EXTRA_INTERESTS} extras specific to the destination. Use it only when the trip purpose is too general to plan around.`,
  props: AgentInterestPickerPropsSchema,
});

export const tripBrief = dataComponent({
  id: 'trip-brief',
  name: IntakeComponent.TripBrief,
  description:
    'A draft of the trip details for the guest to confirm. The app shows it as a one-sentence recap ("So that\'s <purpose> in <destination>, with a focus on <interests>.") with buttons to confirm or change it.',
  props: TripBriefPropsSchema,
});

export const intakeComponents = [interestPicker, tripBrief];
