import {
  CONVERSATION_KEY_HEADER,
  ClaimedConversationSchema,
  type GuestIdentity,
  type TripBriefProps,
} from '@travel-agent/shared';

/**
 * Stores the guest's details with the API, keyed by chat id. The agents read
 * them back from there (via Inkeep's context fetcher) rather than from the chat.
 */
async function put(
  chatId: string,
  path: 'identity' | 'trip',
  body: unknown,
  key: string | undefined,
): Promise<unknown> {
  const res = await fetch(`/api/intake/${encodeURIComponent(chatId)}/${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(key && { [CONVERSATION_KEY_HEADER]: key }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Couldn't save your details (${res.status})`);
  return res.json();
}

/**
 * Stores the guest's name. The first save claims the conversation and returns
 * its key, which every later intake and chat request must send.
 */
export async function saveIdentity(
  chatId: string,
  identity: GuestIdentity,
  key: string | undefined,
): Promise<string | undefined> {
  const res = await put(chatId, 'identity', identity, key);
  return ClaimedConversationSchema.partial().parse(res).conversationKey;
}

export async function confirmTrip(
  chatId: string,
  trip: TripBriefProps,
  key: string | undefined,
): Promise<void> {
  await put(chatId, 'trip', trip, key);
}
