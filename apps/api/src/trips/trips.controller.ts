import { Controller, Get } from '@nestjs/common';
import type { Trip } from '@travel-agent/shared';
import { TripsService } from './trips.service.js';

@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get()
  findAll(): Trip[] {
    return this.tripsService.findAll();
  }
}
