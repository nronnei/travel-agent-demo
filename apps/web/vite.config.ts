import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Set to 0.0.0.0 in the dev container so the dev server is reachable.
    host: process.env.VITE_HOST,
    // The in-cluster dev server is reached through the ingress hostname.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',') ?? [],
    proxy: {
      // Locally, forward API calls to the Nest dev server. In the cluster the
      // ingress routes /api straight to the api service, so this goes unused.
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
    },
  },
});
