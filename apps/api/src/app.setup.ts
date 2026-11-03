import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** App-wide configuration shared by main.ts and the e2e tests. */
export function configureApp(app: NestFastifyApplication) {
  app.setGlobalPrefix('api');
}
