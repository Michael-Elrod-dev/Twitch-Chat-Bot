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

/**
 * How many AI requests one viewer gets per stream, by tier.
 *
 * The broadcaster is deliberately absent. They are unlimited, that is not a
 * number anyone should be able to edit down to three by accident, and the
 * settings screen renders it as the word "Unlimited" rather than a stepper —
 * so there is nothing here for a field to carry.
 *
 * A viewer holding several tiers gets the **best** of them, not the one the
 * code happens to check first. That rule lives in `limitFor` on the server and
 * is stated here because it is what makes "VIPs 5" readable as a floor rather
 * than a cap.
 */
export interface AiLimits {
    everyone: number;
    vip: number;
    subscriber: number;
    moderator: number;
}

/**
 * The upper bound is a guard against a fat finger in a stepper, not a policy.
 * Zero is meaningful and allowed: it turns the AI off for that tier while
 * leaving it on for the ones above.
 */
const aiLimitSchema = z.number().int().min(0).max(10_000);

export const aiLimitsSchema = z.object({
    everyone: aiLimitSchema,
    vip: aiLimitSchema,
    subscriber: aiLimitSchema,
    moderator: aiLimitSchema
});

export interface ChannelSettings {
    aiEnabled: boolean;
    /** All four tiers, always. The screen holds the whole set and edits one row of it. */
    aiLimits: AiLimits;
    songRequestsEnabled: boolean;
    /**
     * Whether requested songs are also appended to a playlist the streamer
     * keeps. Off until they turn it on and name one — saving a viewer's request
     * somewhere nobody asked for is a surprise.
     */
    requestsPlaylistEnabled: boolean;
    /**
     * What the streamer calls that playlist, or null before they have named
     * one. Display and creation only: the server never looks a playlist up by
     * name, because two playlists may share one and picking the wrong one would
     * write a stranger's library.
     */
    requestsPlaylistName: string | null;
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
        /**
         * Whole-set, never partial.
         *
         * A stepper changes one tier, but the screen holds all four and sends
         * all four. Merging a partial server-side would need a read before the
         * write and would silently resolve two people editing at once to
         * whichever request arrived second — with the other tier's change lost
         * inside a body that never mentioned it.
         */
        aiLimits: aiLimitsSchema.optional(),
        songRequestsEnabled: z.boolean().optional(),
        requestsPlaylistEnabled: z.boolean().optional(),
        /**
         * Naming the playlist. Explicit null clears the name, which also clears
         * the id the server resolved for it — a name and the playlist it points
         * at cannot be allowed to drift apart.
         */
        requestsPlaylistName: z.string().trim().min(1).max(100).nullable().optional(),
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
    /**
     * What a built-in *does*, in the streamer's language — the reply column has
     * nothing else to show for a row whose behaviour is code.
     *
     * Null for a static command, whose `responseText` already says everything
     * there is to say.
     *
     * It is served from the handler's own registration rather than assembled in
     * the client. The client-side map that shipped with the content screens had
     * a real cost: a built-in added on the server rendered a generic fallback
     * until somebody remembered to edit a file in the app. Behaviour and the
     * sentence describing it now change in the same place.
     */
    description: string | null;
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

/**
 * The requests playlist, as Spotify currently holds it.
 *
 * Separate from `ChannelSettings.requestsPlaylistName` on purpose: that is what
 * the streamer typed, this is what exists. They disagree in an ordinary case —
 * a playlist named but not yet created, or one deleted from the Spotify app
 * afterwards — and collapsing them would let the settings screen report a
 * track count for a playlist that is gone.
 */
export interface SpotifyPlaylist {
    id: string;
    /** Spotify's name for it, which the streamer may have since renamed there. */
    name: string;
    trackCount: number;
}

/**
 * Everything the Spotify card needs, and nothing that could authenticate.
 *
 * No token, no refresh token, no scope list. The card shows an account name, a
 * date, and a Disconnect button; a response that carried more would put a live
 * credential on the wire for a piece of UI that has no use for one.
 */
export interface SpotifyStatus {
    connected: boolean;
    /** The Spotify display name, or null when not connected. */
    accountName: string | null;
    /** When the link was made — the card's "since 4 Aug". Null when not connected. */
    connectedSince: string | null;
    /**
     * The requests playlist, when one is set AND still exists at Spotify. Null
     * covers both "never named one" and "named one that has since been
     * deleted", which the screen renders identically: there is nothing to show
     * a track count for.
     */
    playlist: SpotifyPlaylist | null;
}

/**
 * What Spotify is playing right now.
 *
 * Null means nothing is playing — a paused player, a closed app, an account
 * that has not started anything. Deliberately not an error: the now-playing
 * card's empty state is an ordinary state, not a failure.
 */
export interface NowPlaying {
    trackName: string;
    artistName: string;
    /** Album art, or null — the card keeps its striped placeholder in that case. */
    albumArtUrl: string | null;
    progressMs: number;
    durationMs: number;
    /**
     * Whether the track is advancing. A paused player still has a track and a
     * position, and the card shows them — with the progress bar frozen rather
     * than the whole card blanked.
     */
    isPlaying: boolean;
    /**
     * Who redeemed it, when this track came from the request queue. Null for
     * anything the streamer started themselves, which is most of a stream.
     */
    requestedByLogin: string | null;
}

// ---- channel point rewards ---------------------------------------------------

export type RewardKind = 'song_request' | 'skip_queue' | 'add_quote';

/**
 * One of the three rewards this application manages.
 *
 * The list is closed and the settings screen states why: a reward the
 * broadcaster made themselves is never in it, and therefore never touched.
 * `bound: false` means we have no reward recorded for that kind — the app can
 * say "not set up" instead of implying something is being managed that is not.
 */
export interface ManagedReward {
    kind: RewardKind;
    /** The reward's title at Twitch, or null when nothing is bound. */
    title: string | null;
    bound: boolean;
}

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

/**
 * Which window the analytics screen is asking about — its three range chips.
 *
 * `all_time` is the cheap one and stays the default: it reads the lifetime
 * counters the bot maintains per message. The other two range over
 * `chat_messages` because a counter cannot be sliced by time, which is a real
 * cost difference and the reason the default is the one it is.
 */
export const analyticsRangeSchema = z
    .enum(['all_time', 'this_stream', 'last_7_days'])
    .default('all_time');
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const analyticsQuerySchema = z.object({ range: analyticsRangeSchema });

/** One row of the streams table on the analytics screen. */
export interface StreamSummary {
    startedAt: string;
    /** Null while the stream is still running — the row reads "live" rather than a length. */
    endedAt: string | null;
    messages: number;
    /**
     * Distinct people who said something during it.
     *
     * Counted from the messages themselves. The `streams` table used to carry a
     * `unique_chatters` column that nothing ever wrote, so it read 0 for every
     * stream ever recorded; it has been dropped rather than backfilled, because
     * a column that lies is worse than a column that is absent — an absent one
     * cannot be picked up by the next query that needs a chatter count.
     */
    chatters: number;
}

export interface AnalyticsSummary {
    /** Which window these figures describe. Echoed back so a late response cannot mislabel a chip. */
    range: AnalyticsRange;
    viewers: number;
    /** Total chat messages recorded in the range. */
    messages: number;
    commandsUsed: number;
    streams: number;
    lastStreamAt: string | null;
    topChatters: { login: string; messageCount: number }[];
    /**
     * Most recent streams first, newest at the top of the table.
     *
     * Empty for a channel that has not streamed with the bot connected. The
     * screen renders the real, small list — never an apologetic empty state:
     * four streams in is a fact about a young channel, not a failure to have
     * data.
     */
    recentStreams: StreamSummary[];
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
