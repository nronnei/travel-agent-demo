import { Test, TestingModule } from '@nestjs/testing';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

describe('TripsController', () => {
  let tripsController: TripsController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [TripsService],
    }).compile();

    tripsController = app.get<TripsController>(TripsController);
  });

  it('returns the sample trips', () => {
    expect(tripsController.findAll()).toHaveLength(2);
  });
});
