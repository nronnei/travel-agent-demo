import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { Config } from './config.js';

/** SQLite on the pod's volume, or memory (tests, and the fallback). */
export function createCheckpointer(config: Config): BaseCheckpointSaver {
  if (config.LANGGRAPH_CHECKPOINTER === 'memory') return new MemorySaver();
  mkdirSync(dirname(config.LANGGRAPH_DB), { recursive: true });
  return SqliteSaver.fromConnString(config.LANGGRAPH_DB);
}
