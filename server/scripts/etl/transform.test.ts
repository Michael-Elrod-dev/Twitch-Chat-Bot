import { describe, it, expect } from 'vitest';
import { routeTokenKey, splitViewer, resolveRequester, assignQuoteNumbers } from './transform.js';
import type { LegacyViewer } from './transform.js';

/**
 * Synthetic fixtures only. The real dump carries live credentials and never
 * appears in a test, a snapshot, or CI.
 */

const viewer = (overrides: Partial<LegacyViewer> = {}): LegacyViewer => ({
    user_id: '123456',
    username: 'someviewer',
    is_moderator: 0,
    is_vip: 0,
    is_subscriber: 0,
    is_broadcaster: 0,
    followed_at: null,
    last_seen: null,
    ...overrides
});

describe('routeTokenKey - the key/value drawer gets dissolved', () => {
    it('routes every key kind to its destination', () => {
        const rows: { name: string; key: string; expected: object; exact: boolean }[] = [
            { name: 'broadcaster access', key: 'broadcasterAccessToken', expected: { kind: 'channel_token', provider: 'twitch', field: 'access' }, exact: true },
            { name: 'broadcaster refresh', key: 'broadcasterRefreshToken', expected: { kind: 'channel_token', provider: 'twitch', field: 'refresh' }, exact: true },
            { name: 'spotify access', key: 'spotifyUserAccessToken', expected: { kind: 'channel_token', provider: 'spotify' }, exact: false },
            { name: 'spotify refresh', key: 'spotifyUserRefreshToken', expected: { kind: 'channel_token', provider: 'spotify' }, exact: false },
            { name: 'bot id', key: 'botId', expected: { kind: 'bot_identity', field: 'userId' }, exact: true },
            { name: 'bot refresh', key: 'botRefreshToken', expected: { kind: 'bot_identity', field: 'refresh' }, exact: true },
            { name: 'channel id', key: 'channelId', expected: { kind: 'channel', field: 'broadcasterId' }, exact: true },
            { name: 'user id', key: 'userId', expected: { kind: 'channel', field: 'broadcasterId' }, exact: true },
            // Server secrets stay OUT of the database. The Claude key and the
            // app's client credentials belong to the environment, and importing
            // them into a table would be a regression.
            { name: 'claude key', key: 'claudeApiKey', expected: { kind: 'server_secret' }, exact: true },
            { name: 'client id', key: 'clientId', expected: { kind: 'server_secret' }, exact: true },
            { name: 'client secret', key: 'clientSecret', expected: { kind: 'server_secret' }, exact: true },
            { name: 'spotify client id', key: 'spotifyClientId', expected: { kind: 'server_secret' }, exact: true },
            { name: 'spotify client secret', key: 'spotifyClientSecret', expected: { kind: 'server_secret' }, exact: true },
            { name: 'ai toggle', key: 'aiEnabled', expected: { kind: 'channel_setting', field: 'aiEnabled' }, exact: true },
            { name: 'discord marker', key: 'lastDiscordNotification', expected: { kind: 'channel_setting', field: 'lastDiscordNotificationAt' }, exact: true }
        ];

        for (const row of rows) {
            if (row.exact) expect(routeTokenKey(row.key), row.name).toEqual(row.expected);
            else expect(routeTokenKey(row.key), row.name).toMatchObject(row.expected);
        }
    });

    it('does not silently swallow an unrecognised key', () => {
        expect(routeTokenKey('somethingNew')).toEqual({ kind: 'ignored' });
    });

    it('covers every key the recovered dump actually contains', () => {
        // Key NAMES only - these are structural, not secret. If a future dump
        // carries a key we do not route, this is the test that notices.
        const keysInDump = [
            'botAccessToken', 'botId', 'botRefreshToken',
            'broadcasterAccessToken', 'broadcasterRefreshToken',
            'channelId', 'claudeApiKey', 'clientId', 'clientSecret',
            'spotifyClientId', 'spotifyClientSecret',
            'spotifyUserAccessToken', 'spotifyUserRefreshToken', 'userId'
        ];

        const unrouted = keysInDump.filter((k) => routeTokenKey(k).kind === 'ignored');
        expect(unrouted).toEqual([]);
    });
});

describe('splitViewer - global identity vs channel-relative roles', () => {
    it('splits identity from role', () => {
        const result = splitViewer(viewer({ user_id: '42', username: 'alice', is_moderator: 1 }));

        expect(result?.identity).toEqual({ twitchUserId: '42', login: 'alice' });
        expect(result?.role.isModerator).toBe(true);
    });

    it('carries every role flag across', () => {
        const result = splitViewer(viewer({ is_moderator: 1, is_vip: 1, is_subscriber: 1, is_broadcaster: 1 }));

        expect(result?.role).toMatchObject({
            isModerator: true, isVip: true, isSubscriber: true, isBroadcaster: true
        });
    });

    it('treats MySQL tinyint 0/1 as booleans', () => {
        expect(splitViewer(viewer({ is_vip: 1 }))?.role.isVip).toBe(true);
        expect(splitViewer(viewer({ is_vip: 0 }))?.role.isVip).toBe(false);
        expect(splitViewer(viewer({ is_vip: null }))?.role.isVip).toBe(false);
    });

    it('accepts only a genuinely numeric user_id', () => {
        const rows: { name: string; id: string; accepted: boolean }[] = [
            // The source data is known to carry usernames in the numeric id
            // column. Importing those under a fabricated id would poison
            // identity permanently, so they are rejected outright.
            { name: 'username in the id column', id: 'someviewer', accepted: false },
            { name: 'empty id', id: '', accepted: false },
            { name: 'whitespace id', id: '   ', accepted: false },
            { name: 'short numeric id', id: '1', accepted: true },
            { name: 'long numeric id', id: '123456789012', accepted: true }
        ];

        for (const row of rows) {
            const result = splitViewer(viewer({ user_id: row.id }));
            if (row.accepted) expect(result, row.name).not.toBeNull();
            else expect(result, row.name).toBeNull();
        }
    });

    it('falls back to the id when the username is missing', () => {
        expect(splitViewer(viewer({ username: '' }))?.identity.login).toBe('123456');
    });

    it('parses timestamps and tolerates junk', () => {
        expect(splitViewer(viewer({ followed_at: '2025-01-15 12:00:00' }))?.role.followedAt).toBeInstanceOf(Date);
        expect(splitViewer(viewer({ followed_at: 'not-a-date' }))?.role.followedAt).toBeNull();
        expect(splitViewer(viewer({ followed_at: null }))?.role.followedAt).toBeNull();
    });
});

describe('resolveRequester - song_queue username becomes an id', () => {
    const loginToId = new Map([['alice', '42'], ['bob', '99']]);

    it('resolves each requester shape', () => {
        const rows: { name: string; input: string | null; expected: { twitchUserId: string | null; login: string | null } }[] = [
            { name: 'known login', input: 'alice', expected: { twitchUserId: '42', login: 'alice' } },
            { name: 'case-insensitive lookup, casing preserved', input: 'ALICE', expected: { twitchUserId: '42', login: 'ALICE' } },
            // An unknown viewer keeps their name. The song must not lose its
            // requester just because that viewer was never recorded.
            { name: 'unknown viewer', input: 'stranger', expected: { twitchUserId: null, login: 'stranger' } },
            { name: 'missing requester', input: null, expected: { twitchUserId: null, login: null } },
            { name: 'blank requester', input: '  ', expected: { twitchUserId: null, login: null } }
        ];

        for (const row of rows) {
            expect(resolveRequester(row.input, loginToId), row.name).toEqual(row.expected);
        }
    });
});

describe('assignQuoteNumbers - per-channel numbering', () => {
    it('numbers from 1 in original id order', () => {
        const result = assignQuoteNumbers([{ quote_id: 10 }, { quote_id: 3 }, { quote_id: 7 }]);

        expect(result.map((r) => [r.quote_id, r.quoteNumber])).toEqual([[3, 1], [7, 2], [10, 3]]);
    });

    it('does not mutate its input', () => {
        const input = [{ quote_id: 2 }, { quote_id: 1 }];
        assignQuoteNumbers(input);

        expect(input.map((r) => r.quote_id)).toEqual([2, 1]);
    });

});
