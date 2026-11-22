import { useLangGraphEngine } from '../chat/useLangGraphEngine';
import { ChatView } from './Chat';

/**
 * The LangGraph chat, in its own chunk: only browsers on the LangGraph
 * backend download the LangGraph SDK and LangChain's message classes.
 */
export default function LangGraphChat() {
  return <ChatView engine={useLangGraphEngine()} />;
}
