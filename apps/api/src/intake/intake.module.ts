import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE, type Database } from '../database/database.module.js';
import { IntakeController } from './intake.controller.js';
import { MemoryIntakeStore } from './intake.memory-store.js';
import { PostgresIntakeStore } from './intake.postgres-store.js';
import { IntakeService } from './intake.service.js';
import { INTAKE_STORE, type IntakeStore } from './intake.store.js';

@Module({
  controllers: [IntakeController],
  providers: [
    {
      provide: INTAKE_STORE,
      inject: [DATABASE, ConfigService],
      useFactory: (db: Database | null, config: ConfigService): IntakeStore => {
        const raw = Number(config.get<string>('INTAKE_MAX_CONVERSATIONS'));
        const max = Number.isInteger(raw) && raw >= 1 ? raw : undefined;
        if (db) return new PostgresIntakeStore(db, max);
        new Logger('Intake').warn(
          'DATABASE_URL is not set: intake records are in memory and lost on restart',
        );
        return new MemoryIntakeStore(max);
      },
    },
    IntakeService,
  ],
  exports: [IntakeService],
})
export class IntakeModule {}
