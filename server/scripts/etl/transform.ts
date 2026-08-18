/**
 * Pure transforms from the recovered dump's MySQL shape into the current schema.
 *
 * Kept free of any I/O so it can be unit-tested on synthetic fixtures. The real
 * dump is never used in tests - it contains live credentials.
 */

/** The dump's `tokens` table was a key/value junk drawer. This is where each key goes. */
export type TokenDestination =
    | { kind: 'channel_token'; provider: 'twitch' | 'spotify'; field: 'access' | 'refresh' }
    | { kind: 'bot_identity'; field: 'userId' | 'refresh' | 'access' }
    | { kind: 'channel'; field: 'broadcasterId' }
    | { kind: 'channel_setting'; field: 'aiEnabled' | 'lastDiscordNotificationAt' }
    | { kind: 'server_secret' }
    | { kind: 'ignored' };

/**
 * Routing table for every key the dump's schema could hold.
 *
 * `server_secret` entries deliberately do NOT land in the database. The Claude
 * key and the app's client credentials belong to the environment, so the import
 * drops them rather than migrating them, and the report says so by count.
 */
export function routeTokenKey(key: string): TokenDestination {
    switch (key) {
    case 'broadcasterAccessToken':
        return { kind: 'channel_token', provider: 'twitch', field: 'access' };
    case 'broadcasterRefreshToken':
        return { kind: 'channel_token', provider: 'twitch', field: 'refresh' };
    case 'spotifyUserAccessToken':
        return { kind: 'channel_token', provider: 'spotify', field: 'access' };
    case 'spotifyUserRefreshToken':
        return { kind: 'channel_token', provider: 'spotify', field: 'refresh' };

    case 'botId':
        return { kind: 'bot_identity', field: 'userId' };
    case 'botRefreshToken':
        return { kind: 'bot_identity', field: 'refresh' };
    case 'botAccessToken':
        // Not persisted: every bot-side Helix call runs on an app access
        // token. Kept in the union so the routing is explicit rather than
        // falling through to `ignored`.
        return { kind: 'bot_identity', field: 'access' };

    case 'channelId':
    case 'userId':
        return { kind: 'channel', field: 'broadcasterId' };

    case 'aiEnabled':
        return { kind: 'channel_setting', field: 'aiEnabled' };
    case 'lastDiscordNotification':
        return { kind: 'channel_setting', field: 'lastDiscordNotificationAt' };

    case 'claudeApiKey':
    case 'clientId':
    case 'clientSecret':
    case 'spotifyClientId':
    case 'spotifyClientSecret':
        return { kind: 'server_secret' };

    default:
        return { kind: 'ignored' };
    }
}

/** The dump stored role flags on the viewer itself. The current schema makes them channel-relative. */
export interface DumpViewer {
    user_id: string;
    username: string;
    is_moderator: number | boolean | null;
    is_vip: number | boolean | null;
    is_subscriber: number | boolean | null;
    is_broadcaster: number | boolean | null;
    followed_at: Date | string | null;
    last_seen: Date | string | null;
}

export interface ViewerIdentity {
    twitchUserId: string;
    login: string;
}

export interface ChannelRole {
    twitchUserId: string;
    isModerator: boolean;
    isVip: boolean;
    isSubscriber: boolean;
    isBroadcaster: boolean;
    followedAt: Date | null;
    lastSeenAt: Date | null;
}

const toBool = (v: number | boolean | null): boolean => v === true || v === 1;

const toDate = (v: Date | string | null): Date | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Splits one dump viewer row into global identity plus channel-relative role.
 *
 * @returns null identity when the row has no usable Twitch id. The source data
 * sometimes carries a username in the numeric id column. Such rows cannot be
 * trusted as identity and are reported as skipped rather than imported under a
 * fabricated id.
 */
export function splitViewer(row: DumpViewer): { identity: ViewerIdentity; role: ChannelRole } | null {
    const id = String(row.user_id ?? '').trim();

    // The source sometimes wrote the username into the id column. A numeric id
    // is the only thing that can be trusted to be a real Twitch user id.
    if (id === '' || !/^\d+$/.test(id)) {
        return null;
    }

    return {
        identity: {
            twitchUserId: id,
            login: String(row.username ?? '').trim() || id
        },
        role: {
            twitchUserId: id,
            isModerator: toBool(row.is_moderator),
            isVip: toBool(row.is_vip),
            isSubscriber: toBool(row.is_subscriber),
            isBroadcaster: toBool(row.is_broadcaster),
            followedAt: toDate(row.followed_at),
            lastSeenAt: toDate(row.last_seen)
        }
    };
}

/** The dump's song_queue stored a username. The current schema stores an id plus a display fallback. */
export function resolveRequester(
    requestedBy: string | null,
    loginToId: Map<string, string>
): { twitchUserId: string | null; login: string | null } {
    const login = (requestedBy ?? '').trim();
    if (login === '') {
        return { twitchUserId: null, login: null };
    }
    return { twitchUserId: loginToId.get(login.toLowerCase()) ?? null, login };
}

/** Quotes gain a per-channel display number, assigned in original id order. */
export function assignQuoteNumbers<T extends { quote_id: number }>(rows: T[]): (T & { quoteNumber: number })[] {
    return [...rows]
        .sort((a, b) => a.quote_id - b.quote_id)
        .map((row, index) => ({ ...row, quoteNumber: index + 1 }));
}
