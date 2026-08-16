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
    it('routes broadcaster Twitch credentials to channel_tokens', () => {
        expect(routeTokenKey('broadcasterAccessToken')).toEqual({
            kind: 'channel_token', provider: 'twitch', field: 'access'
        });
        expect(routeTokenKey('broadcasterRefreshToken')).toEqual({
            kind: 'channel_token', provider: 'twitch', field: 'refresh'
        });
    });

    it('routes Spotify user credentials to channel_tokens', () => {
        expect(routeTokenKey('spotifyUserAccessToken')).toMatchObject({ kind: 'channel_token', provider: 'spotify' });
        expect(routeTokenKey('spotifyUserRefreshToken')).toMatchObject({ kind: 'channel_token', provider: 'spotify' });
    });

    it('routes bot credentials to bot_identity', () => {
        expect(routeTokenKey('botId')).toEqual({ kind: 'bot_identity', field: 'userId' });
        expect(routeTokenKey('botRefreshToken')).toEqual({ kind: 'bot_identity', field: 'refresh' });
    });

    it('routes channel identifiers to the channel row', () => {
        expect(routeTokenKey('channelId')).toEqual({ kind: 'channel', field: 'broadcasterId' });
        expect(routeTokenKey('userId')).toEqual({ kind: 'channel', field: 'broadcasterId' });
    });

    it('classifies server secrets so they are NOT imported', () => {
        // Design §2.3: the Claude key and the app's client credentials move to the
        // environment. Migrating them into the database would be a regression.
        for (const key of ['claudeApiKey', 'clientId', 'clientSecret', 'spotifyClientId', 'spotifyClientSecret']) {
            expect(routeTokenKey(key)).toEqual({ kind: 'server_secret' });
        }
    });

    it('routes per-channel settings out of the drawer', () => {
        expect(routeTokenKey('aiEnabled')).toEqual({ kind: 'channel_setting', field: 'aiEnabled' });
        expect(routeTokenKey('lastDiscordNotification')).toEqual({
            kind: 'channel_setting', field: 'lastDiscordNotificationAt'
        });
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

    it('REJECTS a row whose user_id is a username', () => {
        // Phase 0's P1-4 wrote the username into the numeric id column. Importing
        // those under a fabricated id would poison identity permanently.
        expect(splitViewer(viewer({ user_id: 'someviewer' }))).toBeNull();
    });

    it('rejects an empty user_id', () => {
        expect(splitViewer(viewer({ user_id: '' }))).toBeNull();
        expect(splitViewer(viewer({ user_id: '   ' }))).toBeNull();
    });

    it('accepts a purely numeric id of any length', () => {
        expect(splitViewer(viewer({ user_id: '1' }))).not.toBeNull();
        expect(splitViewer(viewer({ user_id: '123456789012' }))).not.toBeNull();
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

    it('resolves a known login to its id', () => {
        expect(resolveRequester('alice', loginToId)).toEqual({ twitchUserId: '42', login: 'alice' });
    });

    it('is case-insensitive on the login', () => {
        expect(resolveRequester('ALICE', loginToId).twitchUserId).toBe('42');
    });

    it('keeps the display name when the viewer is unknown', () => {
        // The song must not lose its requester's name just because that viewer
        // was never recorded.
        expect(resolveRequester('stranger', loginToId)).toEqual({ twitchUserId: null, login: 'stranger' });
    });

    it('handles a missing requester', () => {
        expect(resolveRequester(null, loginToId)).toEqual({ twitchUserId: null, login: null });
        expect(resolveRequester('  ', loginToId)).toEqual({ twitchUserId: null, login: null });
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

    it('handles an empty set', () => {
        expect(assignQuoteNumbers([])).toEqual([]);
    });
});
