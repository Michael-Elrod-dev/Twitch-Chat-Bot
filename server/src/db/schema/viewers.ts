import { pgTable, text, timestamp, boolean, uuid, index, uniqueIndex, primaryKey, integer } from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

/**
 * Global viewer identity. A Twitch account is one person across every channel,
 * so this table holds only what is genuinely global: who they are.
 *
 * Moderator, VIP and subscriber are not properties of a person. They are
 * properties of a person in a channel, which is why they live in channel_roles.
 */
export const viewers = pgTable(
    'viewers',
    {
        /** Twitch's numeric user id. Never a username, which Twitch permits changing. */
        twitchUserId: text('twitch_user_id').primaryKey(),
        /** Current login. Twitch permits renames, so this is NOT unique. */
        login: text('login').notNull(),
        displayName: text('display_name'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // Lookup by name is a query pattern (commands take @username), but the
        // old UNIQUE(username) is gone: two accounts can legitimately hold the
        // same login over time after a rename.
        index('viewers_login_idx').on(table.login)
    ]
);

/**
 * Channel-relative roles. Someone can be a mod in one channel and a plain
 * viewer in the next.
 */
export const channelRoles = pgTable(
    'channel_roles',
    {
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id')
            .notNull()
            // RESTRICT: a viewer row is shared across channels. Deleting identity
            // out from under other channels' history must be a deliberate act.
            .references(() => viewers.twitchUserId, { onDelete: 'restrict' }),
        isModerator: boolean('is_moderator').notNull().default(false),
        isVip: boolean('is_vip').notNull().default(false),
        isSubscriber: boolean('is_subscriber').notNull().default(false),
        isBroadcaster: boolean('is_broadcaster').notNull().default(false),
        followedAt: timestamp('followed_at', { withTimezone: true }),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        primaryKey({ columns: [table.channelId, table.twitchUserId] }),
        index('channel_roles_channel_last_seen_idx').on(table.channelId, table.lastSeenAt)
    ]
);

/** Stream sessions, now owned by a channel. */
export const streams = pgTable(
    'streams',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        /** Twitch's own stream id where known. Imported rows carry synthetic ids. */
        twitchStreamId: text('twitch_stream_id'),
        startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        title: text('title'),
        category: text('category'),
        peakViewers: integer('peak_viewers').notNull().default(0),
        totalMessages: integer('total_messages').notNull().default(0),
        /*
         * There is no `unique_chatters` here any more, and its absence is the
         * decision. Nothing ever wrote it, so it read 0 for every stream, a
         * figure two separate readers would have had no way to tell from a
         * genuine zero. Distinct chatters are counted from `chat_messages`,
         * which is the only place that actually knows. See migration 0006.
         */
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // Channel-led, as every analytics read filters by channel first.
        index('streams_channel_started_idx').on(table.channelId, table.startedAt),
        uniqueIndex('streams_channel_twitch_stream_key').on(table.channelId, table.twitchStreamId)
    ]
);

export const viewingSessions = pgTable(
    'viewing_sessions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        streamId: uuid('stream_id')
            .notNull()
            // CASCADE: a viewing session is a detail of the stream it belongs to.
            .references(() => streams.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id')
            .notNull()
            .references(() => viewers.twitchUserId, { onDelete: 'restrict' }),
        startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
        endedAt: timestamp('ended_at', { withTimezone: true })
    },
    (table) => [
        index('viewing_sessions_stream_user_idx').on(table.streamId, table.twitchUserId),
        // Serves the "who is still watching" query that closes orphaned sessions.
        index('viewing_sessions_stream_open_idx').on(table.streamId, table.endedAt)
    ]
);
