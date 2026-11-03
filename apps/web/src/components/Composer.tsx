import { Button, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

/**
 * What the chat input is collecting right now. It stays a single chat input
 * row; only its fields change, so structured answers still feel like replies.
 */
export type ComposerMode =
  | { kind: 'name' }
  | {
      kind: 'text';
      placeholder?: string;
      /** The guest answers with a component above instead of typing. */
      locked?: boolean;
    }
  | { kind: 'edit'; label: string; initial: string };

export function Composer({
  mode,
  busy,
  disabled,
  onName,
  onText,
  onCancelEdit,
  onStop,
}: {
  mode: ComposerMode;
  /** An agent reply is streaming: show Stop instead of Send. */
  busy: boolean;
  /** Nothing can be sent right now (e.g. waiting on a scripted reply). */
  disabled: boolean;
  onName: (givenName: string, surname: string) => void;
  /** Returns false when the text was rejected, so it stays in the input. */
  onText: (text: string) => boolean;
  onCancelEdit: () => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [givenName, setGivenName] = useState('');
  const [surname, setSurname] = useState('');
  const firstField = useRef<HTMLInputElement>(null);

  // Prefill when editing a brief detail, and move focus to the new field.
  useEffect(() => {
    setText(mode.kind === 'edit' ? mode.initial : '');
    firstField.current?.focus();
  }, [mode]);

  const canSend =
    !disabled &&
    !busy &&
    (mode.kind === 'name' ? givenName.trim() : text.trim()) !== '';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    if (mode.kind === 'name') {
      onName(givenName.trim(), surname.trim());
      setGivenName('');
      setSurname('');
    } else {
      if (onText(text.trim())) setText('');
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <Stack gap="1">
        {mode.kind === 'edit' && (
          <HStack justify="space-between">
            <Text textStyle="xs" color="fg.muted">
              Changing your {mode.label}
            </Text>
            <Button
              size="2xs"
              variant="plain"
              color="fg.muted"
              onClick={onCancelEdit}
            >
              Cancel
            </Button>
          </HStack>
        )}
        <HStack>
          {mode.kind === 'name' ? (
            <>
              <Input
                ref={firstField}
                value={givenName}
                onChange={(e) => setGivenName(e.target.value)}
                placeholder="First name"
                aria-label="First name"
                autoComplete="given-name"
                flex="2"
              />
              <Input
                value={surname}
                onChange={(e) => setSurname(e.target.value)}
                placeholder="Surname (optional)"
                aria-label="Surname"
                autoComplete="family-name"
                flex="3"
              />
            </>
          ) : (
            <Input
              ref={firstField}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode.kind === 'edit'
                  ? `New ${mode.label}…`
                  : (mode.placeholder ?? 'Type your reply…')
              }
              aria-label={mode.kind === 'edit' ? mode.label : 'Message'}
              disabled={mode.kind === 'text' && mode.locked}
            />
          )}
          {busy ? (
            <Button type="button" variant="outline" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" colorPalette="teal" disabled={!canSend}>
              Send
            </Button>
          )}
        </HStack>
      </Stack>
    </form>
  );
}
