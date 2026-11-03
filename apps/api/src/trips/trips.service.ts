import { Injectable } from '@nestjs/common';
import { TripListSchema, type Trip } from '@travel-agent/shared';

const SAMPLE_TRIPS: Trip[] = [
  {
    id: 'lisbon',
    destination: 'Lisbon, Portugal',
    startDate: '2027-04-10',
    endDate: '2027-04-17',
  },
  {
    id: 'kyoto',
    destination: 'Kyoto, Japan',
    startDate: '2027-10-02',
    endDate: '2027-10-12',
  },
];

@Injectable()
export class TripsService {
  findAll(): Trip[] {
    return TripListSchema.parse(SAMPLE_TRIPS);
  }
}
