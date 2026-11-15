import { Controller, Get } from '@nestjs/common';
import { chatBackend, type AppConfig } from '@travel-agent/shared';

@Controller('config')
export class AppConfigController {
  /** Lets the web app pick the chat engine that matches the API's backend. */
  @Get()
  get(): AppConfig {
    return { chatBackend: chatBackend(process.env) };
  }
}
