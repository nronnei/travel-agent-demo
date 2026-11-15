import { Module } from '@nestjs/common';
import { AppConfigController } from './config.controller.js';

@Module({ controllers: [AppConfigController] })
export class AppConfigModule {}
