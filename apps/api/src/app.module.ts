import { Module } from '@nestjs/common';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { chatBackend } from '@travel-agent/shared';
import { ChatModule } from './chat/chat.module.js';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { LangGraphModule } from './langgraph/langgraph.module.js';
import { ParlantModule } from './parlant/parlant.module.js';
import { SearchModule } from './search/search.module.js';
import { TripsModule } from './trips/trips.module.js';

@Module({
  imports: [
    // Locally the shared .env lives at the repo root; in containers env vars are injected.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    // CHAT_BACKEND picks the agent backend: /api/chat (Inkeep), /api/parlant/*
    // or /api/langgraph/*.
    ConditionalModule.registerWhen(
      ChatModule,
      (env) => chatBackend(env) === 'inkeep',
    ),
    ConditionalModule.registerWhen(
      ParlantModule,
      (env) => chatBackend(env) === 'parlant',
    ),
    ConditionalModule.registerWhen(
      LangGraphModule,
      (env) => chatBackend(env) === 'langgraph',
    ),
    AppConfigModule,
    HealthModule,
    IntakeModule,
    // Both backends' planners search through it (Inkeep over MCP, Parlant over REST).
    SearchModule,
    TripsModule,
  ],
})
export class AppModule {}
