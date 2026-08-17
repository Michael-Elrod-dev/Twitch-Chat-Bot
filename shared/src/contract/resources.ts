import { z } from 'zod';
import {
    chatTextSchema,
    commandNameSchema,
    emoteTriggerSchema,
    userLevelSchema
} from './common.js';

/** The channel the caller's token belongs to. */
export interface ChannelSummary {
    id: string;
    login: string;
    displayName: string | null;
    /**
     * What the world did to this channel. `needs_reauth` is Twitch withdrawing
     * consent; `suspended`/`disconnected` are administrative. None of these are
     * things the broadcaster chose from the app — see `enabled`.
     */
    status: 'active' | 'suspended' | 'disconnected' | 'needs_reauth';
    /**
     * What the owner chose: the header's master switch.
     *
     * Deliberately a separate field from `status`, not a fifth status value.
     * They answer different questions, and collapsing them lies to the
     * broadcaster in both directions — a bot they paused would report itself
     * broken, and a bot Twitch cut off would report itself merely paused. The
     * app needs both to render the header honestly.
     */
    enabled: boolean;
}

/** The header master switch. */
export const setChannelEnabledSchema = z.object({ enabled: z.boolean() });
export type SetChannelEnabledRequest = z.infer<typeof setChannelEnabledSchema>;

/**
 * The result of flipping the switch.
 *
 * Carries `status` as well as `enabled` so the header updates from one round
 * trip — and so the two stay visibly independent: turning the bot off does not
 * change what Twitch thinks of the channel, and this response is where that is
 * asserted rather than assumed.
 */
export interface ChannelEnabledResponse {
    enabled: boolean;
    status: ChannelSummary['status'];
}

export interface ChannelSettings {
    aiEnabled: boolean;
    songRequestsEnabled: boolean;
    /** Write-only in practice: the API reports whether one is set, never its value. */
    discordWebhookConfigured: boolean;
    /**
     * Whether a Spotify account is linked.
     *
     * A boolean and nothing more, for the same reason the webhook is: the
     * dashboard's SPOTIFY tile needs to say "Connected" or "Not set up" and
     * needs no part of the credential to do it. The full surface — account
     * name, linked-since date, disconnect — belongs to the songs settings
     * screen and lands with it; putting it here would ship a payload nothing
     * reads yet and commit us to keeping it right.
     */
    spotifyConnected: boolean;
}

export interface MeResponse {
    twitchUserId: string;
    login: string;
    /** Null when signed in but no channel has been connected — an ordinary state. */
    channel: ChannelSummary | null;
    settings: ChannelSettings | null;
}

export const updateSettingsSchema = z
    .object({
        aiEnabled: z.boolean().optional(),
        songRequestsEnabled: z.boolean().optional(),
        /** Explicit null clears it; omitted leaves it alone. */
        discordWebhookUrl: z.string().url().max(500).nullable().optional()
    })
    // An empty PATCH is almost always a client bug, and silently succeeding
    // would hide it.
    .refine((body) => Object.keys(body).length > 0, { message: 'no settings provided' });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsSchema>;

// ---- commands --------------------------------------------------------------

export interface Command {
    name: string;
    responseText: string | null;
    /** Set when a built-in handler backs this command rather than static text. */
    handlerName: string | null;
    userLevel: z.infer<typeof userLevelSchema>;
}

export const createCommandSchema = z.object({
    name: commandNameSchema,
    responseText: chatTextSchema,
    userLevel: userLevelSchema.default('everyone')
});
export type CreateCommandRequest = z.infer<typeof createCommandSchema>;

export const updateCommandSchema = z
    .object({
        responseText: chatTextSchema.optional(),
        userLevel: userLevelSchema.optional()
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });
export type UpdateCommandRequest = z.infer<typeof updateCommandSchema>;

// ---- emotes ----------------------------------------------------------------

export interface Emote {
    triggerText: string;
    responseText: string;
}

export const createEmoteSchema = z.object({
    triggerText: emoteTriggerSchema,
    responseText: chatTextSchema
});
export type CreateEmoteRequest = z.infer<typeof createEmoteSchema>;

// ---- quotes ----------------------------------------------------------------

export interface Quote {
    quoteNumber: number;
    quoteText: string;
    author: string | null;
}

export const createQuoteSchema = z.object({
    quoteText: z.string().trim().min(1).max(1000),
    author: z.string().trim().max(64).nullable().optional()
});
export type CreateQuoteRequest = z.infer<typeof createQuoteSchema>;

// ---- songs -----------------------------------------------------------------

export interface QueuedSong {
    id: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    requestedByLogin: string | null;
    createdAt: string;
}

export const toggleSongRequestsSchema = z.object({ enabled: z.boolean() });
export type ToggleSongRequestsRequest = z.infer<typeof toggleSongRequestsSchema>;

// ---- dashboard -------------------------------------------------------------

/**
 * The four figures across the top of the dashboard.
 *
 * Scoped to ONE stream — the open one while live, the most recent one when
 * offline. Deliberately not lifetime totals: the dashboard is the glance from
 * the second monitor during a stream, and "4,182 messages" means nothing there
 * if it silently includes every stream that came before.
 */
export interface DashboardNumbers {
    messages: number;
    /** Distinct people who said something, not people watching. */
    chatters: number;
    aiReplies: number;
    pointsRedeemed: number;
}

/**
 * Everything the dashboard needs that is a fact about *now* rather than a
 * change.
 *
 * The realtime feed carries transitions; this carries state. A client that
 * connected mid-stream has missed every transition that ever happened, so
 * without this endpoint the uptime clock would not start until the broadcaster
 * went offline — which is exactly when it stops being interesting.
 *
 * Nothing here is a new table. Every field is a read over rows the bot already
 * writes.
 */
export interface DashboardSummary {
    live: boolean;
    /**
     * The open stream's start, or null offline. Seeds the uptime clock; the
     * `channel.status` event re-syncs it.
     */
    startedAt: string | null;
    /**
     * The current stream's figures while live, the last stream's when offline.
     * Zeroes only ever mean a real zero — a client that cannot reach the server
     * renders `?`, never this.
     */
    numbers: DashboardNumbers;
    /**
     * The stream `numbers` describes, for the offline screen's
     * `Last stream / Thursday · 4h 02m` caption. Null until a channel has
     * streamed once with the bot connected.
     */
    lastStream: { startedAt: string; endedAt: string | null } | null;
}

// ---- analytics -------------------------------------------------------------

export interface AnalyticsSummary {
    viewers: number;
    /** Total chat messages recorded across all streams. */
    messages: number;
    commandsUsed: number;
    streams: number;
    lastStreamAt: string | null;
    topChatters: { login: string; messageCount: number }[];
}

// ---- API keys --------------------------------------------------------------

export interface ApiKeySummary {
    id: string;
    name: string;
    /** Identifiable prefix, so a key can be recognised without storing it. */
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
}

/** The full key, returned exactly once — it is not recoverable afterwards. */
export interface CreatedApiKey extends ApiKeySummary {
    key: string;
}

export const createApiKeySchema = z.object({
    name: z.string().trim().min(1).max(64)
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeySchema>;
