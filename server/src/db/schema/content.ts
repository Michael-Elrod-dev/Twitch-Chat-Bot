import { pgTable, text, timestamp, uuid, index, uniqueIndex, integer, bigserial, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { channels } from './channels.js';
import { viewers, streams } from './viewers.js';

/** Chat commands, now scoped to a channel. */
export const commands = pgTable(
    'commands',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        responseText: text('response_text'),
        /** Set when the command is backed by a handler module rather than static text. */
        handlerName: text('handler_name'),
        userLevel: text('user_level', { enum: ['everyone', 'vip', 'mod', 'broadcaster'] })
            .notNull()
            .default('everyone'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // The channel-scoping constraint: !discord may exist once per channel,
        // and differently in each. Phase 0's global UNIQUE(command_name) is what
        // this replaces.
        uniqueIndex('commands_channel_name_key').on(table.channelId, table.name),
        // Enforced in the database, not just in types: Phase 0 WP-7.1 showed that
        // an unrecognised level silently resolves to unrestricted.
        check('commands_user_level_check', sql`${table.userLevel} in ('everyone', 'vip', 'mod', 'broadcaster')`)
    ]
);

export const emotes = pgTable(
    'emotes',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        triggerText: text('trigger_text').notNull(),
        responseText: text('response_text').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [uniqueIndex('emotes_channel_trigger_key').on(table.channelId, table.triggerText)]
);

export const quotes = pgTable(
    'quotes',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        /** Per-channel display number, so each channel counts from 1. */
        quoteNumber: integer('quote_number').notNull(),
        quoteText: text('quote_text').notNull(),
        author: text('author'),
        /** Who saved it. SET NULL: losing the saver must not lose the quote. */
        savedByTwitchUserId: text('saved_by_twitch_user_id').references(() => viewers.twitchUserId, {
            onDelete: 'set null'
        }),
        savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [uniqueIndex('quotes_channel_number_key').on(table.channelId, table.quoteNumber)]
);

export const songQueue = pgTable(
    'song_queue',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        trackUri: text('track_uri').notNull(),
        trackName: text('track_name'),
        artistName: text('artist_name'),
        /**
         * Requester as a Twitch user id, not a username - the Phase-0 register
         * item where song_queue stored a display name while everything else
         * stored ids. SET NULL so a purged viewer does not delete a queued song.
         */
        requestedByTwitchUserId: text('requested_by_twitch_user_id'),
        /** Denormalised for display when the viewer row is gone. */
        requestedByLogin: text('requested_by_login'),
        queuePosition: integer('queue_position').notNull(),
        addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // The queue is always read per channel in position order.
        index('song_queue_channel_position_idx').on(table.channelId, table.queuePosition),
        // Named explicitly: Drizzle's generated name for this FK is 64 characters,
        // one over Postgres's 63-char identifier limit, so the server truncated it
        // silently and the database ended up with a name the migration file did
        // not contain.
        foreignKey({
            name: 'song_queue_requested_by_viewers_fk',
            columns: [table.requestedByTwitchUserId],
            foreignColumns: [viewers.twitchUserId]
        }).onDelete('set null')
    ]
);

/**
 * Chat message analytics. The highest-volume table by a wide margin, so its
 * indexes are the ones that matter.
 */
export const chatMessages = pgTable(
    'chat_messages',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        streamId: uuid('stream_id').references(() => streams.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id')
            .notNull()
            .references(() => viewers.twitchUserId, { onDelete: 'restrict' }),
        messageType: text('message_type', { enum: ['message', 'command', 'redemption'] })
            .notNull()
            .default('message'),
        content: text('content'),
        messageTime: timestamp('message_time', { withTimezone: true }).notNull()
    },
    (table) => [
        // Carries forward Phase 0's WP-7 index decision, now channel-led: every
        // analytics read filters channel, then stream, then ranges over time.
        index('chat_messages_channel_stream_time_idx').on(table.channelId, table.streamId, table.messageTime),
        index('chat_messages_channel_user_idx').on(table.channelId, table.twitchUserId),
        check('chat_messages_type_check', sql`${table.messageType} in ('message', 'command', 'redemption')`)
    ]
);

/** Lifetime per-channel counters. */
export const chatTotals = pgTable(
    'chat_totals',
    {
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id')
            .notNull()
            .references(() => viewers.twitchUserId, { onDelete: 'restrict' }),
        messageCount: integer('message_count').notNull().default(0),
        commandCount: integer('command_count').notNull().default(0),
        redemptionCount: integer('redemption_count').notNull().default(0),
        totalCount: integer('total_count').notNull().default(0),
        lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [primaryKey({ columns: [table.channelId, table.twitchUserId] })]
);

/**
 * AI usage counters. api_type is a plain varchar, closing the Phase-0 register
 * item where a single-value ENUM would have needed a migration to add a provider.
 */
export const apiUsage = pgTable(
    'api_usage',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id')
            .notNull()
            .references(() => viewers.twitchUserId, { onDelete: 'restrict' }),
        streamId: uuid('stream_id').references(() => streams.id, { onDelete: 'cascade' }),
        apiType: text('api_type').notNull(),
        usageCount: integer('usage_count').notNull().default(0),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        /*
         * NOTE: Postgres treats NULLs in a unique index as DISTINCT, so this
         * does not constrain rows where `stream_id` is null — which is exactly
         * the offline bucket. `NULLS NOT DISTINCT` would fix it but this
         * Drizzle version cannot express it, so the AI rate limiter serialises
         * its own read-then-write under a channel row lock instead. See
         * server/src/ai/rateLimiter.ts.
         */
        uniqueIndex('api_usage_channel_user_type_stream_key').on(
            table.channelId,
            table.twitchUserId,
            table.apiType,
            table.streamId
        )
    ]
);

/**
 * Channel-point rewards this application manages.
 *
 * The P1-WP3 policy made concrete: redemptions route by **reward id**, never by
 * title. Phase 0 matched on the title string, which meant renaming a reward in
 * the Twitch dashboard silently broke it, and two rewards with similar names
 * were a coin flip.
 *
 * A reward only appears here if the app created it or adopted it, and adoption
 * requires `only_manageable_rewards` to have returned it — so a reward the
 * broadcaster made by hand is never in this table and is never touched. Those
 * are explicitly none of our business.
 */
export const channelRewards = pgTable(
    'channel_rewards',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        /** What the bot does when this reward is redeemed. */
        kind: text('kind', { enum: ['song_request', 'skip_queue', 'add_quote'] }).notNull(),
        /** Twitch's reward id - the routing key. */
        rewardId: text('reward_id').notNull(),
        /** Display only, for logs and the dashboard. Never used for routing. */
        title: text('title').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // One reward per kind per channel: a channel cannot have two "song
        // request" rewards, which would make routing ambiguous.
        uniqueIndex('channel_rewards_channel_kind_key').on(table.channelId, table.kind),
        // And one kind per reward: the same reward cannot mean two things.
        uniqueIndex('channel_rewards_channel_reward_key').on(table.channelId, table.rewardId),
        check(
            'channel_rewards_kind_check',
            sql`${table.kind} in ('song_request', 'skip_queue', 'add_quote')`
        )
    ]
);

/**
 * What has already been appended to a channel's requests playlist.
 *
 * This table IS the dedup mechanism, and it exists to avoid the Phase-0 one:
 * `spotifyManager` paged the entire playlist on every request to check for a
 * duplicate, which is a flagged hot-path sin — an unbounded number of Spotify
 * calls on the redemption path, growing with the playlist, for a question a
 * unique index answers in one round trip.
 *
 * Keyed by playlist as well as track: a streamer who starts a new playlist for
 * a new season should get their songs again, not silence.
 */
export const playlistAdditions = pgTable(
    'playlist_additions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        /** Spotify's playlist id at the time of the append. */
        playlistId: text('playlist_id').notNull(),
        trackUri: text('track_uri').notNull(),
        addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        uniqueIndex('playlist_additions_channel_playlist_track_key')
            .on(table.channelId, table.playlistId, table.trackUri)
    ]
);
