import { Alert, Box, Card, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  BASE_INTERESTS,
  BRIEF_CONFIRMED_MESSAGE,
  INTAKE_GREETING,
  IntakeComponent,
  IntakeComponentDataSchema,
  MAX_EXTRA_INTERESTS,
  TripBriefPropsSchema,
  destinationQuestion,
  formalAddress,
  interestsAnswer,
  nameAnswer,
  prefixAnswer,
  titleQuestion,
  type ChatBackend,
  type GuestIdentity,
  type IntakeComponentData,
  type NamePrefix,
  type TripBriefProps,
  type WidgetAnswer,
} from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Composer, type ComposerMode } from './Composer';
import {
  IntakeComponentView,
  type BriefField,
  type IntakeHandlers,
} from './IntakeComponents';
import { confirmTrip, saveIdentity } from './intakeApi';
import { SafeMarkdown } from './SafeMarkdown';
import { SearchIndicator, SourceChips } from './SearchActivity';
import type { ChatEngine } from '../chat/engine';
import {
  SEARCH_PART,
  SearchActivitySchema,
  sourceChips,
  type SearchActivity,
} from '../chat/searchActivity';
import { useAiSdkEngine } from '../chat/useAiSdkEngine';
import { useParlantEngine } from '../chat/useParlantEngine';

/** A short pause before scripted replies, so they read like the concierge typing. */
const SCRIPT_DELAY_MS = 600;

const UPDATED_BRIEF = 'Of course. Here is the updated brief:';

function localMessage(
  role: 'user' | 'assistant',
  parts: UIMessage['parts'],
): UIMessage {
  return { id: crypto.randomUUID(), role, parts };
}
const textPart = (text: string) => ({ type: 'text' as const, text });
const componentPart = (data: IntakeComponentData) => ({
  type: 'data-component' as const,
  data,
});

function messageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'component'; component: IntakeComponentData }
  | { kind: 'search'; activity: SearchActivity };

/**
 * An assistant message's text and data components, in the order they arrived,
 * with the turn's web search activity (if any) placed around them: the
 * "searching" row above the text, the source chips below it, and nothing when
 * every search failed (the reply says what to verify). Both engines represent
 * widgets as `data-component` parts and search as a `data-search` part;
 * unknown or malformed ones are dropped.
 */
function messageSegments(message: UIMessage): Segment[] {
  const segments: Segment[] = [];
  let search: SearchActivity | undefined;
  for (const part of message.parts) {
    if (part.type === SEARCH_PART) {
      const parsed = SearchActivitySchema.safeParse(
        (part as { data: unknown }).data,
      );
      if (parsed.success) search = parsed.data;
      continue;
    }
    if (part.type === 'text') {
      const last = segments.at(-1);
      if (last?.kind === 'text') last.text += part.text;
      else if (part.text) segments.push({ kind: 'text', text: part.text });
    } else if (part.type === 'data-component') {
      const parsed = IntakeComponentDataSchema.safeParse(part.data);
      if (parsed.success)
        segments.push({ kind: 'component', component: parsed.data });
    }
  }
  const visible = segments.filter((s) => s.kind !== 'text' || s.text.trim());
  // The recap ends with "Have I got that right?", so it reads last even if the
  // agent's own sentence streamed after it.
  const isRecap = (s: Segment) =>
    s.kind === 'component' && s.component.name === IntakeComponent.TripBrief;
  const ordered = [
    ...visible.filter((s) => !isRecap(s)),
    ...visible.filter(isRecap),
  ];
  if (search?.state === 'searching')
    return [{ kind: 'search', activity: search }, ...ordered];
  if (search?.state === 'done' && sourceChips(search).length)
    return [...ordered, { kind: 'search', activity: search }];
  return ordered;
}

/**
 * Inkeep reports agent failures (e.g. a rejected model call) as `data-operation`
 * stream parts rather than AI SDK errors, so useChat's `error` stays unset.
 */
function agentErrors(message: UIMessage): string[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'data-operation') return [];
    const data = part.data as { type?: string; message?: string };
    return data.type === 'error' && data.message ? [data.message] : [];
  });
}

const bubbleCss = {
  '& p + p, & ul, & ol': { marginTop: '2' },
  '& ul, & ol': { paddingInlineStart: '5' },
  '& ul': { listStyleType: 'disc' },
  '& ol': { listStyleType: 'decimal' },
};

function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <Stack
      alignSelf="flex-start"
      maxW="85%"
      gap="3"
      px="4"
      py="2"
      rounded="l3"
      bg="bg.muted"
      color="fg"
      css={bubbleCss}
    >
      {children}
    </Stack>
  );
}

function MessageBubble({
  message,
  active,
  handlers,
}: {
  message: UIMessage;
  /** Whether this message's components still accept answers. */
  active: boolean;
  handlers: IntakeHandlers;
}) {
  if (message.role === 'user') {
    return (
      <Box
        alignSelf="flex-end"
        maxW="85%"
        px="4"
        py="2"
        rounded="l3"
        colorPalette="teal"
        bg="colorPalette.solid"
        color="colorPalette.contrast"
      >
        <Text whiteSpace="pre-wrap">{messageText(message)}</Text>
      </Box>
    );
  }

  const segments = messageSegments(message);
  if (segments.length === 0) {
    const errors = agentErrors(message);
    if (errors.length === 0) return null;
    return (
      <Alert.Root status="error" alignSelf="flex-start" maxW="85%">
        <Alert.Indicator />
        <Alert.Title>The agent couldn't answer: {errors.at(-1)}</Alert.Title>
      </Alert.Root>
    );
  }

  return (
    <AssistantBubble>
      {segments.map((segment, i) =>
        segment.kind === 'text' ? (
          <SafeMarkdown key={i}>{segment.text}</SafeMarkdown>
        ) : segment.kind === 'search' ? (
          segment.activity.state === 'searching' ? (
            <SearchIndicator key={i} activity={segment.activity} />
          ) : (
            <SourceChips key={i} activity={segment.activity} />
          )
        ) : (
          <IntakeComponentView
            key={i}
            component={segment.component}
            active={active}
            handlers={handlers}
          />
        ),
      )}
    </AssistantBubble>
  );
}

/**
 * Where the intake stands. Name and title are scripted here (no model call) so
 * they are exactly what the guest typed; the intake agent takes over from the
 * destination question.
 */
type Step =
  | { kind: 'name' }
  | { kind: 'title'; givenName: string; surname: string }
  | { kind: 'agent' };

/** A brief detail the guest tapped to change. */
type Edit = { field: BriefField; brief: TripBriefProps };

function editAnswer(
  field: Exclude<BriefField, 'interests'>,
  value: string,
): string {
  return field === 'destination'
    ? `Let's make the destination ${value}.`
    : `Let's make it ${value}.`;
}

/** The chat screen, shared by every agent backend; `engine` talks to the agent. */
export function ChatView({ engine }: { engine: ChatEngine }) {
  const {
    id: chatId,
    messages,
    setMessages,
    status,
    error,
    clearError,
  } = engine;
  const [step, setStep] = useState<Step>({ kind: 'name' });
  // Issued by the API when the guest's identity is first stored; proves this
  // browser owns the conversation on every later intake and chat request.
  const conversationKey = useRef<string>(undefined);
  const [edit, setEdit] = useState<Edit | null>(null);
  // A brief the guest edited here, in the app, that the agent hasn't seen yet.
  // It goes along with their next message so the agent builds on it.
  const [editedBrief, setEditedBrief] = useState<TripBriefProps | null>(null);
  const [placeholder, setPlaceholder] = useState<string>();
  const [typing, setTyping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  const busy = status === 'submitted' || status === 'streaming';
  const waiting = typing || saving;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, typing, engine.typing]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function append(...added: UIMessage[]) {
    setMessages((current) => [...current, ...added]);
  }

  /** A scripted concierge reply, after a short typing pause. */
  function reply(...parts: UIMessage['parts']) {
    setTyping(true);
    timers.current.push(
      window.setTimeout(() => {
        append(localMessage('assistant', parts));
        setTyping(false);
      }, SCRIPT_DELAY_MS),
    );
  }

  function say(text: string) {
    append(localMessage('user', [textPart(text)]));
  }

  /** A turn for the intake/planner agents, with any brief edits they haven't seen. */
  function send(text: string, brief = editedBrief, answer?: WidgetAnswer) {
    if (!text || busy) return;
    clearError();
    setLocalError(null);
    setPlaceholder(undefined);
    setEditedBrief(null);
    engine.send(text, { key: conversationKey.current, brief, answer });
  }

  /** Shows a brief the guest edited locally (no agent turn). */
  function showBrief(brief: TripBriefProps) {
    setEditedBrief(brief);
    reply(
      textPart(UPDATED_BRIEF),
      componentPart({ name: IntakeComponent.TripBrief, props: brief }),
    );
  }

  function onName(givenName: string, surname: string) {
    say(nameAnswer({ givenName, surname }));
    setStep({ kind: 'title', givenName, surname });
    reply(
      componentPart({
        name: IntakeComponent.PrefixPicker,
        props: { prompt: titleQuestion(givenName) },
      }),
    );
  }

  async function onPrefix(prefix: NamePrefix) {
    if (step.kind !== 'title') return;
    const identity: GuestIdentity = {
      givenName: step.givenName,
      surname: step.surname,
      prefix,
    };
    say(prefixAnswer(prefix));
    setSaving(true);
    try {
      // Stored before the first agent turn: the agents read the name from here.
      conversationKey.current =
        (await saveIdentity(chatId, identity, conversationKey.current)) ??
        conversationKey.current;
      setStep({ kind: 'agent' });
      reply(textPart(destinationQuestion(formalAddress(identity))));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
      reply(
        componentPart({
          name: IntakeComponent.PrefixPicker,
          props: {
            prompt:
              'Sorry, something went wrong on our side. Could you choose again?',
          },
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  /** Returns false to keep the text in the composer (it was rejected). */
  function onText(text: string): boolean {
    if (edit && edit.field !== 'interests') {
      const brief = { ...edit.brief, [edit.field]: text };
      if (!TripBriefPropsSchema.safeParse(brief).success) {
        setLocalError(
          `Please enter the ${edit.field} in full, up to 200 characters.`,
        );
        return false;
      }
      setEdit(null);
      setLocalError(null);
      say(editAnswer(edit.field, text));
      showBrief(brief);
      return true;
    }
    // Typing instead of using the re-offered interest picker ends that edit.
    setEdit(null);
    send(text);
    return true;
  }

  const handlers: IntakeHandlers = {
    onPrefix: (prefix) => void onPrefix(prefix),
    onInterests(labels) {
      if (edit?.field === 'interests') {
        const brief = { ...edit.brief, interests: labels };
        setEdit(null);
        say(interestsAnswer(labels));
        showBrief(brief);
      } else {
        send(interestsAnswer(labels), editedBrief, {
          type: 'interests',
          labels,
        });
      }
    },
    onEditBrief(field, brief) {
      setEdit({ field, brief });
      if (field !== 'interests') return;
      // Re-offer the picker, keeping any destination-specific interests they had chosen.
      const base = new Set<string>(BASE_INTERESTS.map((i) => i.label));
      const extras = brief.interests
        .filter((label) => !base.has(label))
        .slice(0, MAX_EXTRA_INTERESTS)
        .map((label) => ({
          id: label.toLowerCase().replace(/\W+/g, '-'),
          label,
        }));
      reply(
        componentPart({
          name: IntakeComponent.InterestPicker,
          props: {
            prompt: 'Which interests should we focus on?',
            extras,
            selected: brief.interests,
          },
        }),
      );
    },
    async onConfirmBrief(brief) {
      setEdit(null);
      setSaving(true);
      try {
        // The planner reads the confirmed brief from the API, not from the chat,
        // so no edit note: the intake agent expects this message verbatim.
        await confirmTrip(chatId, brief, conversationKey.current);
        setSaving(false);
        send(BRIEF_CONFIRMED_MESSAGE, null, { type: 'confirm' });
      } catch (err) {
        setSaving(false);
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    },
    onChangeSomething() {
      setEdit(null);
      setPlaceholder('What would you like to change?');
    },
  };

  // Memoised so the composer only resets and refocuses when the mode really changes.
  const mode = useMemo<ComposerMode>(() => {
    if (step.kind === 'name') return { kind: 'name' };
    if (step.kind === 'title')
      return {
        kind: 'text',
        placeholder: 'Choose a title above…',
        locked: true,
      };
    if (edit && edit.field !== 'interests') {
      return {
        kind: 'edit',
        label: edit.field,
        initial: edit.brief[edit.field],
      };
    }
    return { kind: 'text', placeholder };
  }, [step.kind, edit, placeholder]);

  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>Plan a trip</Card.Title>
      </Card.Header>
      <Card.Body gap="4">
        <Stack
          ref={scrollRef}
          gap="3"
          maxH="60vh"
          minH="40"
          overflowY="auto"
          pl="4"
        >
          <AssistantBubble>
            <Text>{INTAKE_GREETING}</Text>
          </AssistantBubble>
          {messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              active={!busy && !waiting && i === messages.length - 1}
              handlers={handlers}
            />
          ))}
          {(status === 'submitted' || typing || engine.typing) && (
            <Stack
              direction="row"
              align="center"
              gap="2"
              alignSelf="flex-start"
            >
              <Spinner size="sm" />
              {engine.activity && !typing && (
                <Text fontSize="sm" color="fg.muted">
                  {engine.activity}
                </Text>
              )}
            </Stack>
          )}
        </Stack>

        {(error || localError) && (
          <Alert.Root status="error">
            <Alert.Indicator />
            <Alert.Title>
              {localError ?? (error?.message || 'Something went wrong')}
            </Alert.Title>
          </Alert.Root>
        )}

        <Composer
          mode={mode}
          busy={busy}
          disabled={waiting || step.kind === 'title'}
          onName={onName}
          onText={onText}
          onCancelEdit={() => setEdit(null)}
          onStop={() => engine.stop(conversationKey.current)}
        />
      </Card.Body>
    </Card.Root>
  );
}

function InkeepChat() {
  return <ChatView engine={useAiSdkEngine()} />;
}

function ParlantChat() {
  return <ChatView engine={useParlantEngine()} />;
}

const LangGraphChat = lazy(() => import('./LangGraphChat'));

/** The chat, on whichever agent backend the API is configured for. */
export function Chat({ backend }: { backend: ChatBackend }) {
  if (backend === 'parlant') return <ParlantChat />;
  if (backend === 'langgraph')
    return (
      <Suspense fallback={<Spinner />}>
        <LangGraphChat />
      </Suspense>
    );
  return <InkeepChat />;
}
