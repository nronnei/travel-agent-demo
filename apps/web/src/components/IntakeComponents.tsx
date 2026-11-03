import { Button, Stack, Text, Wrap, chakra } from '@chakra-ui/react';
import {
  BASE_INTERESTS,
  NAME_PREFIXES,
  NAME_PREFIX_LABELS,
  type IntakeComponentData,
  type InterestPickerProps,
  type NamePrefix,
  type PrefixPickerProps,
  type TripBriefProps,
} from '@travel-agent/shared';
import { useState, type ReactNode } from 'react';

export type BriefField = 'destination' | 'purpose' | 'interests';

/** How the chat responds to the guest using an intake component. */
export interface IntakeHandlers {
  onPrefix: (prefix: NamePrefix) => void;
  onInterests: (labels: string[]) => void;
  onConfirmBrief: (brief: TripBriefProps) => void;
  onEditBrief: (field: BriefField, brief: TripBriefProps) => void;
  onChangeSomething: () => void;
}

/** `active` is false once the guest has moved on, so old components can't be re-used. */
interface ViewProps {
  active: boolean;
  handlers: IntakeHandlers;
}

function PrefixPicker({
  prompt,
  active,
  handlers,
}: PrefixPickerProps & ViewProps) {
  return (
    <Stack gap="2">
      <Text>{prompt}</Text>
      <Wrap gap="2">
        {NAME_PREFIXES.map((prefix) => (
          <Button
            key={prefix}
            size="sm"
            rounded="full"
            variant="outline"
            colorPalette="teal"
            disabled={!active}
            onClick={() => handlers.onPrefix(prefix)}
          >
            {NAME_PREFIX_LABELS[prefix]}
          </Button>
        ))}
      </Wrap>
    </Stack>
  );
}

function InterestPicker({
  prompt,
  extras,
  selected: initial,
  active,
  handlers,
}: InterestPickerProps & ViewProps) {
  // Dedupe by label in case the agent repeats a standard interest as an extra.
  const options = [...BASE_INTERESTS, ...extras].filter(
    (option, i, all) => all.findIndex((o) => o.label === option.label) === i,
  );
  const [selected, setSelected] = useState<string[]>(initial);

  function toggle(label: string) {
    setSelected((current) =>
      current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label],
    );
  }

  return (
    <Stack gap="3">
      <Text>{prompt}</Text>
      <Wrap gap="2">
        {options.map(({ id, label }) => {
          const on = selected.includes(label);
          return (
            <Button
              key={id}
              size="sm"
              rounded="full"
              colorPalette="teal"
              variant={on ? 'solid' : 'outline'}
              aria-pressed={on}
              disabled={!active}
              onClick={() => toggle(label)}
            >
              {label}
            </Button>
          );
        })}
      </Wrap>
      {active && (
        <Button
          alignSelf="flex-start"
          size="sm"
          colorPalette="teal"
          disabled={selected.length === 0}
          onClick={() => handlers.onInterests(selected)}
        >
          Continue
        </Button>
      )}
    </Stack>
  );
}

/** "a, b and c" */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Lowercase a leading capital for mid-sentence use, unless it looks like a proper noun or acronym. */
function midSentence(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** A tappable detail inside the recap sentence. */
function Detail({
  children,
  active,
  label,
  onEdit,
}: {
  children: ReactNode;
  active: boolean;
  label: string;
  onEdit: () => void;
}) {
  if (!active) return <Text as="strong">{children}</Text>;
  return (
    <chakra.button
      type="button"
      onClick={onEdit}
      aria-label={`Change ${label}`}
      title={`Change ${label}`}
      fontWeight="semibold"
      color="teal.fg"
      textDecoration="underline dashed"
      textUnderlineOffset="3px"
      cursor="pointer"
      _hover={{ textDecorationStyle: 'solid' }}
      _focusVisible={{
        outline: '2px solid',
        outlineColor: 'teal.focusRing',
        rounded: 'xs',
      }}
    >
      {children}
    </chakra.button>
  );
}

/** The brief, read back as one conversational sentence the guest can confirm or tap to change. */
function TripRecap({ active, handlers, ...brief }: TripBriefProps & ViewProps) {
  const edit = (field: BriefField) => () => handlers.onEditBrief(field, brief);
  const interests = brief.interests.map(midSentence);

  return (
    <Stack gap="3">
      <Text>
        So that's{' '}
        <Detail active={active} label="purpose" onEdit={edit('purpose')}>
          {midSentence(brief.purpose)}
        </Detail>{' '}
        in{' '}
        <Detail
          active={active}
          label="destination"
          onEdit={edit('destination')}
        >
          {brief.destination}
        </Detail>
        ,{' '}
        {interests.length > 0 ? (
          <>
            with a focus on{' '}
            <Detail
              active={active}
              label="interests"
              onEdit={edit('interests')}
            >
              {listPhrase(interests)}
            </Detail>
          </>
        ) : (
          <>
            with{' '}
            <Detail
              active={active}
              label="interests"
              onEdit={edit('interests')}
            >
              no particular focus
            </Detail>
          </>
        )}
        . Have I got that right?
      </Text>
      {active && (
        <>
          <Wrap gap="2">
            <Button
              size="sm"
              rounded="full"
              colorPalette="teal"
              onClick={() => handlers.onConfirmBrief(brief)}
            >
              Looks perfect
            </Button>
            <Button
              size="sm"
              rounded="full"
              variant="outline"
              colorPalette="teal"
              onClick={handlers.onChangeSomething}
            >
              Change something
            </Button>
          </Wrap>
          <Text textStyle="xs" color="fg.muted">
            Tap any highlighted detail to change it.
          </Text>
        </>
      )}
    </Stack>
  );
}

export function IntakeComponentView({
  component,
  active,
  handlers,
}: {
  component: IntakeComponentData;
} & ViewProps) {
  switch (component.name) {
    case 'PrefixPicker':
      return (
        <PrefixPicker
          {...component.props}
          active={active}
          handlers={handlers}
        />
      );
    case 'InterestPicker':
      return (
        <InterestPicker
          {...component.props}
          active={active}
          handlers={handlers}
        />
      );
    case 'TripBrief':
      return (
        <TripRecap {...component.props} active={active} handlers={handlers} />
      );
  }
}
