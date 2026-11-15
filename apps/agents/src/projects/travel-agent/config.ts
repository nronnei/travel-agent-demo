// Per-environment settings, read at push time. Each environment (local, dev,
// prod) gets its own Inkeep project, so a push for one never repoints another:
// scripts/push-agents.sh sets these for the homelab namespaces, and the API of
// each environment names its project (INKEEP_PROJECT_ID, chart inkeep.projectId).
export const projectId = process.env.INKEEP_PROJECT_ID ?? 'travel-agent';

// Where Inkeep reaches this environment's Nest API, as seen from the Inkeep
// container: it is baked into the project's intake context fetcher and the
// travel-search MCP server. The default is the `npm run dev` setup, where the
// API runs on the host (see .env.example).
export const intakeApiUrl =
  process.env.INTAKE_API_URL ?? 'http://host.docker.internal:3000';
