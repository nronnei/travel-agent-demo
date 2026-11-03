import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from './chat/chat.module.js';
import { HealthModule } from './health/health.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { TripsModule } from './trips/trips.module.js';

@Module({
  imports: [
    // Locally the shared .env lives at the repo root; in containers env vars are injected.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ChatModule,
    HealthModule,
    IntakeModule,
    TripsModule,
  ],
})
export class AppModule {}
