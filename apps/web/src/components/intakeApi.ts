import type { GuestIdentity, TripBriefProps } from '@travel-agent/shared';

/**
 * Stores the guest's details with the API, keyed by chat id. The agents read
 * them back from there (via Inkeep's context fetcher) rather than from the chat.
 */
async function put(chatId: string, path: 'identity' | 'trip', body: unknown) {
  const res = await fetch(`/api/intake/${encodeURIComponent(chatId)}/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Couldn't save your details (${res.status})`);
}

export const saveIdentity = (chatId: string, identity: GuestIdentity) =>
  put(chatId, 'identity', identity);

export const confirmTrip = (chatId: string, trip: TripBriefProps) =>
  put(chatId, 'trip', trip);
