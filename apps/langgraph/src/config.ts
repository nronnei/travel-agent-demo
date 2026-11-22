import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8900),
  /**
   * The Nest API, for the intake record and web search. LANGGRAPH_INTAKE_API_URL
   * wins: under `npm run dev` the repo .env's INTAKE_API_URL is the one Inkeep's
   * container uses (host.docker.internal), which the host can't reach.
   */
  INTAKE_API_URL: z.string().url().default('http://127.0.0.1:3000'),
  LANGGRAPH_INTAKE_API_URL: z.string().url().optional(),
  INTAKE_API_TOKEN: z.string().default(''),
  SEARCH_API_TOKEN: z.string().default(''),
  /** Bearer token the Nest API sends; the stream route is 503 without it. */
  LANGGRAPH_API_TOKEN: z.string().default(''),
  LANGGRAPH_INTAKE_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  LANGGRAPH_PLANNING_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  LANGGRAPH_CHECKPOINTER: z
    .enum(['sqlite', 'memory', 'postgres'])
    .default('sqlite'),
  /** SQLite: Helm sets the volume's path; locally it's a gitignored file in apps/langgraph. */
  LANGGRAPH_DB: z.string().min(1).default('checkpoints.db'),
  /** Postgres: the service's own database in the environment's cluster (Helm sets it). */
  LANGGRAPH_DATABASE_URL: z.string().min(1).optional(),
  /** The cluster CA; required for any database host other than localhost. */
  LANGGRAPH_DATABASE_SSL_ROOT_CERT: z.string().min(1).optional(),
}).superRefine((env, ctx) => {
  if (env.LANGGRAPH_CHECKPOINTER === 'postgres' && !env.LANGGRAPH_DATABASE_URL)
    ctx.addIssue({
      code: 'custom',
      path: ['LANGGRAPH_DATABASE_URL'],
      message: 'LANGGRAPH_CHECKPOINTER=postgres needs LANGGRAPH_DATABASE_URL',
    });
});
export type Config = z.infer<typeof EnvSchema>;

/** Reads and validates the environment once; empty strings count as unset. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const config = EnvSchema.parse(set);
  return {
    ...config,
    INTAKE_API_URL: config.LANGGRAPH_INTAKE_API_URL ?? config.INTAKE_API_URL,
  };
}
