import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { HelixApi, rateLimitDelayMs } from './helixApi.js';
import { AppTokenProvider } from './appTokenProvider.js';
import { HelixError, RateLimitedError } from './errors.js';

const logger = pino({ level: 'silent' });
const CLIENT_ID = 'test-client-id';
const APP_TOKEN = 'app-access-token-value';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function buildTokens(): AppTokenProvider {
    return new AppTokenProvider({
        clientId: CLIENT_ID,
        clientSecret: 'secret',
        logger,
        fetchImpl: async () => jsonResponse(200, { access_token: APP_TOKEN, expires_in: 5_000_000 })
    });
}

describe('HelixApi', () => {
    let calls: { url: string; init: RequestInit | undefined }[];

    const build = (responder: (call: number) => Response, sleep = vi.fn(async () => undefined)): HelixApi => {
        calls = [];
        let n = 0;
        return new HelixApi({
            clientId: CLIENT_ID,
            appTokens: buildTokens(),
            logger,
            createSpacingMs: 0,
            sleep,
            fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
                calls.push({ url: String(url), init });
                return responder(n++);
            }
        });
    };

    describe('request basics', () => {
        it('sends the bearer token and client id', async () => {
            const api = build(() => jsonResponse(200, { data: [] }));
            await api.getUsers(['someone']);

            const headers = calls[0]?.init?.headers as Record<string, string>;
            expect(headers['authorization']).toBe(`Bearer ${APP_TOKEN}`);
            expect(headers['client-id']).toBe(CLIENT_ID);
        });

        it('builds query strings from arrays and skips empty values', async () => {
            const api = build(() => jsonResponse(200, { data: [] }));
            await api.getUsers(['a', 'b'], []);

            const url = new URL(calls[0]?.url as string);
            expect(url.searchParams.getAll('login')).toEqual(['a', 'b']);
            expect(url.searchParams.has('id')).toBe(false);
        });

        it('surfaces Twitch message on a non-2xx', async () => {
            const api = build(() => jsonResponse(400, { message: 'Missing required parameter' }));

            await expect(api.getUsers(['x'])).rejects.toThrow(HelixError);
            await api.getUsers(['x']).catch((err: HelixError) => {
                expect(err.status).toBe(400);
                expect(err.twitchMessage).toBe('Missing required parameter');
            });
        });

        it('never echoes the bearer token into an error', async () => {
            const api = build(() => jsonResponse(403, { message: 'forbidden' }));

            await api.getUsers(['x']).catch((err: Error) => {
                expect(err.message).not.toContain(APP_TOKEN);
            });
        });

        it('handles a 204 with no body', async () => {
            const api = build(() => new Response(null, { status: 204 }));

            await expect(api.deleteEventSubSubscription('sub-1')).resolves.toBeUndefined();
        });
    });

    describe('401 handling', () => {
        it('refreshes the app token and retries exactly once', async () => {
            // An app token can be revoked before its stated expiry. One retry;
            // a second 401 is a real authorization problem, not a stale token.
            const api = build((n) => (n === 0
                ? jsonResponse(401, { message: 'Invalid OAuth token' })
                : jsonResponse(200, { data: [{ id: '1', login: 'a', display_name: 'A' }] })));

            expect(await api.getUsers(['a'])).toHaveLength(1);
            expect(calls).toHaveLength(2);
        });

        it('gives up after the retry also fails', async () => {
            const api = build(() => jsonResponse(401, { message: 'Invalid OAuth token' }));

            await expect(api.getUsers(['a'])).rejects.toThrow(HelixError);
            expect(calls).toHaveLength(2);
        });

        it('does not retry a user-token call', async () => {
            // A user token is not ours to refresh here; retrying with the same
            // one would just produce a second 401.
            const api = build(() => jsonResponse(401, { message: 'Invalid OAuth token' }));

            await expect(api.getChatters('1', '1', 'user-token')).rejects.toThrow(HelixError);
            expect(calls).toHaveLength(1);
        });
    });

    describe('429 handling', () => {
        it('throws a typed error rather than retrying in place', async () => {
            // A thundering herd of automatic retries is how a rate limit becomes
            // an outage.
            const api = build(() => jsonResponse(429, { message: 'Too Many Requests' }));

            await expect(api.getUsers(['a'])).rejects.toThrow(RateLimitedError);
            expect(calls).toHaveLength(1);
        });

        it('carries the wait implied by Ratelimit-Reset', async () => {
            const resetAt = Math.floor(Date.now() / 1000) + 30;
            const api = build(() => jsonResponse(429, {}, { 'ratelimit-reset': String(resetAt) }));

            await api.getUsers(['a']).catch((err: RateLimitedError) => {
                expect(err.retryAfterMs).toBeGreaterThan(25_000);
                expect(err.retryAfterMs).toBeLessThanOrEqual(30_000);
            });
        });
    });

    describe('rateLimitDelayMs', () => {
        const now = 1_700_000_000_000;

        it('reads Ratelimit-Reset as unix seconds', () => {
            const headers = new Headers({ 'ratelimit-reset': String(now / 1000 + 20) });
            expect(rateLimitDelayMs(headers, now)).toBe(20_000);
        });

        it('falls back to Retry-After seconds', () => {
            expect(rateLimitDelayMs(new Headers({ 'retry-after': '15' }), now)).toBe(15_000);
        });

        it('falls back to a fixed delay when neither is usable', () => {
            // Never zero: an instant retry is the behaviour a rate limit exists
            // to prevent.
            expect(rateLimitDelayMs(new Headers(), now)).toBeGreaterThan(0);
            expect(rateLimitDelayMs(new Headers({ 'ratelimit-reset': 'garbage' }), now)).toBeGreaterThan(0);
        });

        it('ignores an already-past reset', () => {
            const headers = new Headers({ 'ratelimit-reset': String(now / 1000 - 100) });
            expect(rateLimitDelayMs(headers, now)).toBeGreaterThan(0);
        });

        it('refuses an absurd reset rather than sleeping for hours', () => {
            const headers = new Headers({ 'ratelimit-reset': String(now / 1000 + 999_999) });
            expect(rateLimitDelayMs(headers, now)).toBeLessThan(60 * 60_000);
        });
    });

    describe('pagination', () => {
        it('follows the cursor when listing subscriptions', async () => {
            // A partial list would look like missing subscriptions and the
            // reconciler would recreate every one of them.
            const api = build((n) => (n === 0
                ? jsonResponse(200, { data: [{ id: 'a' }], pagination: { cursor: 'next' } })
                : jsonResponse(200, { data: [{ id: 'b' }], pagination: {} })));

            expect(await api.listEventSubSubscriptions()).toHaveLength(2);
            expect(calls).toHaveLength(2);
            expect(calls[1]?.url).toContain('after=next');
        });

        it('follows the cursor when listing chatters', async () => {
            const api = build((n) => (n === 0
                ? jsonResponse(200, {
                    data: [{ user_id: '1', user_login: 'one' }],
                    pagination: { cursor: 'c' }
                })
                : jsonResponse(200, { data: [{ user_id: '2', user_login: 'two' }] })));

            // The login rides along: presence writes both, and an id with no
            // name turns every viewer row into an unreadable number.
            expect(await api.getChatters('1', '2', 'user-token')).toEqual([
                { twitchUserId: '1', login: 'one' },
                { twitchUserId: '2', login: 'two' }
            ]);
        });
    });

    describe('subscription creation pacing', () => {
        it('spaces consecutive creates', async () => {
            // Twitch allows 100/minute; a bulk re-subscribe would otherwise burst
            // straight through the budget.
            const sleep = vi.fn(async () => undefined);
            const clock = 1_000_000;
            const api = new HelixApi({
                clientId: CLIENT_ID,
                appTokens: buildTokens(),
                logger,
                createSpacingMs: 500,
                sleep,
                now: () => clock,
                fetchImpl: async () => jsonResponse(200, { data: [{ id: 's', type: 't', version: '1', status: 'x', condition: {} }] })
            });

            const input = {
                type: 't', version: '1', condition: {},
                transport: { method: 'webhook' as const, callback: 'https://x/y', secret: 's' }
            };

            await api.createEventSubSubscription(input);
            await api.createEventSubSubscription(input);

            expect(sleep).toHaveBeenCalledWith(500);
        });

        it('does not delay the very first create', async () => {
            const sleep = vi.fn(async () => undefined);
            const api = new HelixApi({
                clientId: CLIENT_ID, appTokens: buildTokens(), logger, createSpacingMs: 500, sleep,
                fetchImpl: async () => jsonResponse(200, { data: [{ id: 's', type: 't', version: '1', status: 'x', condition: {} }] })
            });

            await api.createEventSubSubscription({
                type: 't', version: '1', condition: {},
                transport: { method: 'webhook', callback: 'https://x/y', secret: 's' }
            });

            expect(sleep).not.toHaveBeenCalled();
        });

        it('keeps the chain moving after a failed create', async () => {
            // A rejected promise left in the chain would deadlock every
            // subsequent create behind it.
            let n = 0;
            const api = new HelixApi({
                clientId: CLIENT_ID, appTokens: buildTokens(), logger, createSpacingMs: 0,
                sleep: async () => undefined,
                fetchImpl: async () => (n++ === 0
                    ? jsonResponse(500, { message: 'boom' })
                    : jsonResponse(200, { data: [{ id: 'ok', type: 't', version: '1', status: 'x', condition: {} }] }))
            });

            const input = {
                type: 't', version: '1', condition: {},
                transport: { method: 'webhook' as const, callback: 'https://x/y', secret: 's' }
            };

            await expect(api.createEventSubSubscription(input)).rejects.toThrow(HelixError);
            await expect(api.createEventSubSubscription(input)).resolves.toMatchObject({ id: 'ok' });
        });
    });

    describe('sendChatMessage', () => {
        it('reports a successful send', async () => {
            const api = build(() => jsonResponse(200, { data: [{ message_id: 'm', is_sent: true }] }));

            expect(await api.sendChatMessage('1001', 'bot', 'hello')).toEqual({ sent: true });
        });

        it('reports an accepted-but-dropped message with its reason', async () => {
            // AutoMod accepts and then drops. A silent drop would look exactly
            // like a bug in whatever produced the message.
            const api = build(() => jsonResponse(200, {
                data: [{ message_id: 'm', is_sent: false, drop_reason: { code: 'automod_held', message: 'held by AutoMod' } }]
            }));

            expect(await api.sendChatMessage('1001', 'bot', 'hi')).toEqual({
                sent: false, dropReason: 'held by AutoMod'
            });
        });

        it('posts broadcaster, sender and message', async () => {
            const api = build(() => jsonResponse(200, { data: [{ message_id: 'm', is_sent: true }] }));
            await api.sendChatMessage('1001', 'bot-9', 'hello there');

            expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
                broadcaster_id: '1001', sender_id: 'bot-9', message: 'hello there'
            });
        });
    });

    describe('channel point rewards', () => {
        it('creates a reward with a user token', async () => {
            const api = build(() => jsonResponse(200, {
                data: [{ id: 'r1', title: 'Test', cost: 100, is_enabled: true }]
            }));

            expect(await api.createCustomReward('1001', 'user-token', { title: 'Test', cost: 100 }))
                .toMatchObject({ id: 'r1', title: 'Test' });

            const headers = calls[0]?.init?.headers as Record<string, string>;
            // The user token, not the app token: only a user token can manage rewards.
            expect(headers['authorization']).toBe('Bearer user-token');
        });

        it('lists only rewards this application can manage', async () => {
            // The P1-WP3 finding made concrete: a dashboard-created reward cannot
            // have its redemption status updated by us, so it must not be listed
            // as if it could.
            const api = build(() => jsonResponse(200, { data: [] }));
            await api.listCustomRewards('1001', 'user-token');

            expect(new URL(calls[0]?.url as string).searchParams.get('only_manageable_rewards')).toBe('true');
        });

        it('updates a redemption status - the refund path', async () => {
            const api = build(() => new Response(null, { status: 204 }));
            await api.updateRedemptionStatus('1001', 'user-token', 'reward-1', 'redemption-1', 'CANCELED');

            const url = new URL(calls[0]?.url as string);
            expect(calls[0]?.init?.method).toBe('PATCH');
            expect(url.searchParams.get('reward_id')).toBe('reward-1');
            expect(url.searchParams.get('id')).toBe('redemption-1');
            expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ status: 'CANCELED' });
        });
    });

    describe('getStream', () => {
        it('returns null when the channel is offline', async () => {
            const api = build(() => jsonResponse(200, { data: [] }));

            expect(await api.getStream('1001')).toBeNull();
        });
    });
});
