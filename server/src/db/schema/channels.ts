import { pgTable, text, timestamp, boolean, uuid, uniqueIndex, index, jsonb, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Tenancy root. Every tenant-scoped table hangs off this one.
 *
 * ON DELETE policy across the schema, stated once here:
 *   - Anything that is *part of* a channel (its settings, tokens, content,
 *     analytics) CASCADEs: deleting a channel means the channel is gone, and
 *     leaving its commands behind would be orphaned rows nobody can reach.
 *   - Anything that merely *references* a globally-shared row (viewers)
 *     RESTRICTs, so we cannot silently destroy identity that other channels
 *     still point at.
 */
export const channels = pgTable(
    'channels',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        /** Twitch's numeric broadcaster id. The real-world identity of the tenant. */
        twitchBroadcasterId: text('twitch_broadcaster_id').notNull(),
        /** Current login name. Twitch allows renames, so this is display data, not a key. */
        twitchLogin: text('twitch_login').notNull(),
        displayName: text('display_name'),
        status: text('status', { enum: ['active', 'suspended', 'disconnected'] })
            .notNull()
            .default('active'),
        onboardedAt: timestamp('onboarded_at', { withTimezone: true }).notNull().defaultNow(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // One tenant per Twitch channel. This is the constraint that makes
        // onboarding idempotent.
        uniqueIndex('channels_twitch_broadcaster_id_key').on(table.twitchBroadcasterId),
        index('channels_status_idx').on(table.status),
        // Drizzle's `{ enum: [...] }` is a TypeScript-only refinement - it emits a
        // plain text column. Without this the database accepts any string, and
        // anything writing SQL directly (the ETL, a manual fix) could store junk.
        check('channels_status_check', sql`${table.status} in ('active', 'suspended', 'disconnected')`)
    ]
);

/**
 * Per-channel OAuth credentials.
 *
 * The broadcaster's Twitch token pair is genuinely required (not merely
 * convenient): Update Redemption Status - the refund path - accepts only a user
 * access token with channel:manage:redemptions. See the WP-3 report.
 */
export const channelTokens = pgTable(
    'channel_tokens',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: uuid('channel_id')
            .notNull()
            // CASCADE: credentials are meaningless without their channel, and
            // leaving them behind would leave live secrets with no owner.
            .references(() => channels.id, { onDelete: 'cascade' }),
        provider: text('provider', { enum: ['twitch', 'spotify'] }).notNull(),
        accessToken: text('access_token').notNull(),
        refreshToken: text('refresh_token').notNull(),
        /** Absolute expiry. Phase 0 learned to store this rather than re-derive it. */
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // One credential set per provider per channel.
        uniqueIndex('channel_tokens_channel_provider_key').on(table.channelId, table.provider),
        check('channel_tokens_provider_check', sql`${table.provider} in ('twitch', 'spotify')`)
    ]
);

/** Per-channel behaviour knobs. Replaces the Phase-0 `tokens` key/value junk drawer. */
export const channelSettings = pgTable('channel_settings', {
    channelId: uuid('channel_id')
        .primaryKey()
        .references(() => channels.id, { onDelete: 'cascade' }),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    discordWebhookUrl: text('discord_webhook_url'),
    /** Last go-live post, for the notification cooldown. */
    lastDiscordNotificationAt: timestamp('last_discord_notification_at', { withTimezone: true }),
    songRequestsEnabled: boolean('song_requests_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * The shared bot account's authorization record.
 *
 * Deliberately NOT a rotating token pair. Every Helix call the bot itself makes
 * (send chat message, create EventSub subscriptions, get chatters) runs on an
 * *app* access token, which derives from the application's client credentials
 * plus prior user consent - not from a stored bot user token. What we must
 * persist is the identity and the fact of consent. See the WP-3 report for the
 * per-endpoint enumeration behind this.
 */
export const botIdentity = pgTable('bot_identity', {
    id: uuid('id').primaryKey().defaultRandom(),
    twitchUserId: text('twitch_user_id').notNull().unique(),
    twitchLogin: text('twitch_login').notNull(),
    /** Scopes the bot account granted the application (user:read:chat, user:write:chat, user:bot). */
    grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull().default([]),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Kept only so consent can be re-verified or re-established without a manual
     * re-auth. It is NOT on any request path.
     */
    refreshToken: text('refresh_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/** Schema-prep only: no UI until a later phase (design §2.4). */
export const editors = pgTable(
    'editors',
    {
        channelId: uuid('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        twitchUserId: text('twitch_user_id').notNull(),
        role: text('role', { enum: ['owner', 'editor'] }).notNull().default('editor'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        primaryKey({ columns: [table.channelId, table.twitchUserId] }),
        check('editors_role_check', sql`${table.role} in ('owner', 'editor')`)
    ]
);
