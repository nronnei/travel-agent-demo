import type { GuestIdentity, TripBriefProps } from '@travel-agent/shared';
import {
  customType,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** bytea as a Buffer on both drivers: pg returns a Buffer, PGlite a Uint8Array. */
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

/** Guest intake: identity, the confirmed and draft briefs, and what links a claim to the agents. */
export const intake = pgSchema('intake');

export const conversations = intake.table(
  'conversations',
  {
    conversationId: text('conversation_id').primaryKey(),
    /** SHA-256 of the conversation key; the key itself is never stored. */
    keyHash: bytea('key_hash').notNull(),
    threadId: text('thread_id').notNull().unique(),
    /** Set once, the first time this claim chats on the Parlant backend. */
    parlantSessionId: text('parlant_session_id'),
    identity: jsonb('identity').$type<GuestIdentity>().notNull(),
    trip: jsonb('trip').$type<TripBriefProps>(),
    draft: jsonb('draft').$type<TripBriefProps>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Bumped by writes and (at most hourly) by chat turns; retention prunes on it. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('conversations_last_seen_at_idx').on(t.lastSeenAt)],
);
