import { TripListSchema, type Trip } from '@travel-agent/shared';

export async function fetchTrips(signal?: AbortSignal): Promise<Trip[]> {
  const res = await fetch('/api/trips', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/trips failed: ${res.status}`);
  }
  return TripListSchema.parse(await res.json());
}
