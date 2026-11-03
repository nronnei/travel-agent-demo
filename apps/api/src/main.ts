import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  configureApp(app);
  app.enableShutdownHooks();
  // Fastify binds to localhost by default, which is unreachable inside a container.
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
await bootstrap();
