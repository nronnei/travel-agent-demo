import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { ParlantClient } from './parlant.client.js';
import { ParlantController } from './parlant.controller.js';
import { ParlantService } from './parlant.service.js';

@Module({
  imports: [IntakeModule],
  controllers: [ParlantController],
  providers: [ParlantClient, ParlantService],
})
export class ParlantModule {}
