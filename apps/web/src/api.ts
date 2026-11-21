import {
  AppConfigSchema,
  TripListSchema,
  type AppConfig,
  type Trip,
} from '@travel-agent/shared';

export async function fetchTrips(signal?: AbortSignal): Promise<Trip[]> {
  const res = await fetch('/api/trips', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/trips failed: ${res.status}`);
  }
  return TripListSchema.parse(await res.json());
}

/** The API's runtime settings; decides which chat engine to use. */
export async function fetchConfig(signal?: AbortSignal): Promise<AppConfig> {
  const res = await fetch('/api/config', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/config failed: ${res.status}`);
  }
  return AppConfigSchema.parse(await res.json());
}
