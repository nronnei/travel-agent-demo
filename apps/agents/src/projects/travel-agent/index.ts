import { project } from '@inkeep/agents-sdk';
import { travelAgent } from './agents/travel-agent';
import { projectId } from './config';

export const travelAgentProject = project({
  id: projectId,
  name:
    projectId === 'travel-agent'
      ? 'Travel Agent'
      : `Travel Agent (${projectId.replace(/^travel-agent-/, '')})`,
  description: 'Conversational travel planning assistant',
  models: {
    // Not in Inkeep's built-in model registry yet; it falls back to a 120k-token
    // context window for compression, which is fine for chat.
    base: { model: 'anthropic/claude-sonnet-5-5' },
  },
  agents: () => [travelAgent],
});
