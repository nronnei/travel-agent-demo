import type { TripBriefProps, WidgetAnswer } from '@travel-agent/shared';
import type { UIMessage } from 'ai';

/** Options for one guest turn sent to the agent. */
export interface SendOptions {
  /** The conversation key issued when the guest's identity was stored. */
  key: string | undefined;
  /** A brief the guest edited in the app that the agent hasn't seen yet. */
  brief: TripBriefProps | null;
  /**
   * The structured form of a widget answer, sent alongside the same text.
   * LangGraph resumes its paused widget with it; the other engines ignore it.
   */
  answer?: WidgetAnswer;
}

/**
 * What the chat screen needs from an agent backend. Messages are AI SDK
 * `UIMessage`s for both backends, so rendering (text plus `data-component`
 * parts) is shared; only how turns are sent and replies arrive differs.
 */
export interface ChatEngine {
  /** The conversation id, also the key for the guest's intake record. */
  id: string;
  messages: UIMessage[];
  setMessages: (update: (current: UIMessage[]) => UIMessage[]) => void;
  /** Sends one guest turn. */
  send: (text: string, options: SendOptions) => void;
  /** Waiting on the agent: `submitted` before it replies, `streaming` while it does. */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** The backend reports the agent is composing a reply (Parlant status events). */
  typing: boolean;
  /** What the agent is doing before it replies, when the backend says (Parlant). */
  activity?: string;
  error: Error | undefined;
  clearError: () => void;
  /** Cancels the agent's reply in progress. */
  stop: (key: string | undefined) => void;
}
