import { project } from '@inkeep/agents-sdk';
import { travelAgent } from './agents/travel-agent';

export const travelAgentProject = project({
  id: 'travel-agent',
  name: 'Travel Agent',
  description: 'Conversational travel planning assistant',
  models: {
    // Not in Inkeep's built-in model registry yet; it falls back to a 120k-token
    // context window for compression, which is fine for chat.
    base: { model: 'anthropic/claude-sonnet-5-5' },
  },
  agents: () => [travelAgent],
});
