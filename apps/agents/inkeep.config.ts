import { defineConfig } from '@inkeep/agents-cli/config';
import { config } from 'dotenv';

// Secrets and URLs live in the repo-root .env (see .env.example).
config({ path: new URL('../../.env', import.meta.url), quiet: true });

export default defineConfig({
  tenantId: process.env.INKEEP_TENANT_ID ?? 'default',
  agentsApi: {
    // 127.0.0.1 rather than localhost avoids IPv6 resolution issues with the container port.
    url: process.env.INKEEP_AGENTS_API_URL ?? 'http://127.0.0.1:3002',
    apiKey: process.env.INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET,
  },
  manageUiUrl: 'http://localhost:3001',
});
