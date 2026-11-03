import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [IntakeModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
