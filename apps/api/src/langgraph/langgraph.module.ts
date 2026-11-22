import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { LangGraphClient } from './langgraph.client.js';
import { LangGraphController } from './langgraph.controller.js';

@Module({
  imports: [IntakeModule],
  controllers: [LangGraphController],
  providers: [LangGraphClient],
})
export class LangGraphModule {}
