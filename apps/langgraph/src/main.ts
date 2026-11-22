import { ChatAnthropic } from '@langchain/anthropic';
import { IntakeClient, SearchClient } from './apiClient.js';
import { createCheckpointer } from './checkpointer.js';
import { loadConfig } from './config.js';
import { buildGraph } from './graph.js';
import { buildServer } from './server.js';

const config = loadConfig();

// Sonnet 5.5 thinks by default and rejects {type: 'disabled'}; 'between_tools'
// is its "off": no thinking before a reply, only short notes between tool calls.
const model = (name: string) =>
  new ChatAnthropic({
    model: name,
    maxTokens: 4096,
    thinking: { type: 'between_tools' } as never,
  });

const checkpointer = await createCheckpointer(config);

const graph = buildGraph({
  models: {
    intake: model(config.LANGGRAPH_INTAKE_MODEL),
    planner: model(config.LANGGRAPH_PLANNING_MODEL),
  },
  intakeClient: new IntakeClient(
    config.INTAKE_API_URL,
    config.INTAKE_API_TOKEN,
  ),
  searchClient: new SearchClient(
    config.INTAKE_API_URL,
    config.SEARCH_API_TOKEN,
  ),
  checkpointer: checkpointer.saver,
});

const app = buildServer({ graph, apiToken: config.LANGGRAPH_API_TOKEN });
if (!config.LANGGRAPH_API_TOKEN)
  app.log.warn('LANGGRAPH_API_TOKEN is not set: the stream route returns 503');
if (!config.INTAKE_API_TOKEN) app.log.warn('INTAKE_API_TOKEN is not set');

await app.listen({ host: '0.0.0.0', port: config.PORT });

// Close the server, then the database pool, when Kubernetes stops the pod.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => checkpointer.close())
      .finally(() => process.exit(0));
  });
