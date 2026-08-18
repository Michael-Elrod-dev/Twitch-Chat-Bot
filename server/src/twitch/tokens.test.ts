import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { AppTokenProvider } from './appTokenProvider.js';
import { UserTokenProvider } from './userTokenProvider.js';
import { ManualReauthRequiredError, TwitchError } from './errors.js';
import type { ChannelTokenRepository, StoredTokens } from '../db/repositories/channelTokenRepository.js';

const logger = pino({ level: 'silent' });

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AppTokenProvider', () => {
    it('fetches a token and caches it', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'app-token', expires_in: 5_000_000 }));
        const provider = new AppTokenProvider({ clientId: 'id', clientSecret: 'secret', logger, fetchImpl });

        expect(await provider.get()).toBe('app-token');
        expect(await provider.get()).toBe('app-token');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('never puts the client secret in an error', async () => {
        const secret = 'the-client-secret-value';
        const fetchImpl = vi.fn(async () => jsonResponse(403, { message: 'invalid client' }));
        const provider = new AppTokenProvider({ clientId: 'id', clientSecret: secret, logger, fetchImpl });

        await expect(provider.get()).rejects.toThrow(TwitchError);
        await provider.get().catch((err: Error) => {
            expect(err.message).not.toContain(secret);
        });
    });

    describe('single flight', () => {
        it('makes one request for many concurrent callers', async () => {
            // Without this, a restart under load stampedes the token endpoint and
            // every caller races to overwrite the cache.
            let resolveFetch!: (value: Response) => void;
            const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
            const fetchImpl = vi.fn(() => pending);

            const provider = new AppTokenProvider({ clientId: 'id', clientSecret: 's', logger, fetchImpl });

            const callers = Promise.all(Array.from({ length: 10 }, () => provider.get()));
            resolveFetch(jsonResponse(200, { access_token: 'shared', expires_in: 5_000_000 }));

            expect(await callers).toEqual(Array(10).fill('shared'));
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(provider.refreshes).toBe(1);
        });

        it('allows a new request after the in-flight one settles', async () => {
            const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 't', expires_in: 5_000_000 }));
            const provider = new AppTokenProvider({ clientId: 'id', clientSecret: 's', logger, fetchImpl });

            await provider.get();
            provider.invalidate();
            await provider.get();

            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    });

    describe('expiry', () => {
        it('refreshes inside the safety margin rather than at expiry', async () => {
            let now = 1_000_000;
            const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'a', expires_in: 3600 }));
            const provider = new AppTokenProvider({
                clientId: 'id', clientSecret: 's', logger, fetchImpl, now: () => now
            });

            await provider.get();
            now += 3600_000 - 30_000; // 30s left: inside the 60s margin
            await provider.get();

            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });

        it('applies a floor to an implausibly short lifetime', async () => {
            // Trusting a four-second expires_in would park the token permanently
            // inside the margin and make every call a refresh.
            let now = 1_000_000;
            const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'a', expires_in: 4 }));
            const provider = new AppTokenProvider({
                clientId: 'id', clientSecret: 's', logger, fetchImpl, now: () => now
            });

            await provider.get();
            now += 60_000;
            await provider.get();

            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });
    });

    it('reports a non-JSON error body without exploding', async () => {
        const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));
        const provider = new AppTokenProvider({ clientId: 'id', clientSecret: 's', logger, fetchImpl });

        await expect(provider.get()).rejects.toThrow(/non-JSON/);
    });
});

describe('UserTokenProvider', () => {
    let stored: StoredTokens | null;
    let repository: ChannelTokenRepository;
    let upserted: Parameters<ChannelTokenRepository['upsert']>[1][];

    beforeEach(() => {
        upserted = [];
        stored = {
            accessToken: 'current-access',
            refreshToken: 'current-refresh',
            expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
            scopes: ['channel:bot']
        };
        repository = {
            get: async () => stored,
            upsert: async (_provider: string, tokens: never) => { upserted.push(tokens); }
        } as unknown as ChannelTokenRepository;
    });

    const build = (fetchImpl: typeof fetch, now = () => Date.now()): UserTokenProvider =>
        new UserTokenProvider({
            clientId: 'id', clientSecret: 'secret', channelId: 'c1', repository, logger, fetchImpl, now
        });

    it('returns the stored token when it is comfortably valid', async () => {
        const fetchImpl = vi.fn();
        expect(await build(fetchImpl as unknown as typeof fetch).get()).toBe('current-access');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refreshes inside the safety margin', async () => {
        stored = { ...(stored as StoredTokens), expiresAt: new Date(Date.now() + 60_000) };
        const fetchImpl = vi.fn(async () =>
            jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 14_400 }));

        expect(await build(fetchImpl).get()).toBe('new-access');
    });

    it('refreshes when no expiry is recorded', async () => {
        // An unknown expiry is not a valid one.
        stored = { ...(stored as StoredTokens), expiresAt: null };
        const fetchImpl = vi.fn(async () =>
            jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 14_400 }));

        expect(await build(fetchImpl).get()).toBe('new-access');
    });

    it('persists both halves together', async () => {
        // Twitch issues a NEW refresh token on every refresh; writing them
        // separately could strand the channel holding a retired one.
        const fetchImpl = vi.fn(async () =>
            jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 14_400 }));

        await build(fetchImpl).refresh();

        expect(upserted).toHaveLength(1);
        expect(upserted[0]).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    });

    it('applies the lifetime floor', async () => {
        const now = 1_000_000_000;
        const fetchImpl = vi.fn(async () =>
            jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 5 }));

        await build(fetchImpl, () => now).refresh();

        expect((upserted[0]?.expiresAt as Date).getTime()).toBeGreaterThan(now + 10 * 60_000);
    });

    describe('a dead refresh token', () => {
        it('raises the distinct manual-reauth error, not a generic failure', async () => {
            // Retrying this forever is how a bot stays quietly disconnected.
            const fetchImpl = vi.fn(async () =>
                jsonResponse(400, { status: 400, message: 'Invalid refresh token' }));

            await expect(build(fetchImpl).refresh()).rejects.toThrow(ManualReauthRequiredError);
        });

        it('names the channel so the log says which one to reconnect', async () => {
            const fetchImpl = vi.fn(async () => jsonResponse(400, { message: 'Invalid refresh token' }));

            await build(fetchImpl).refresh().catch((err: ManualReauthRequiredError) => {
                expect(err.channelId).toBe('c1');
                expect(err.message).toMatch(/MANUAL RE-AUTHORIZATION REQUIRED/);
            });
        });

        it('raises it when there are no stored tokens at all', async () => {
            stored = null;

            await expect(build(vi.fn() as unknown as typeof fetch).get())
                .rejects.toThrow(ManualReauthRequiredError);
        });

        it('does not persist anything', async () => {
            const fetchImpl = vi.fn(async () => jsonResponse(400, { message: 'Invalid refresh token' }));

            await build(fetchImpl).refresh().catch(() => undefined);

            expect(upserted).toHaveLength(0);
        });
    });

    it('treats a server error as retryable, not as manual reauth', async () => {
        // A 500 is Twitch having a bad day; escalating it to "the user must
        // re-authorize" would send people to reconnect a working channel.
        const fetchImpl = vi.fn(async () => jsonResponse(500, { message: 'internal' }));

        await expect(build(fetchImpl).refresh()).rejects.toThrow(TwitchError);
        await expect(build(fetchImpl).refresh()).rejects.not.toThrow(ManualReauthRequiredError);
    });

    it('never puts a token value in an error', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(500, { message: 'internal' }));

        await build(fetchImpl).refresh().catch((err: Error) => {
            expect(err.message).not.toContain('current-refresh');
            expect(err.message).not.toContain('secret');
        });
    });

    it('collapses concurrent refreshes into one', async () => {
        // Two simultaneous refreshes would race, and the loser would persist a
        // refresh token Twitch invalidated when it issued the winner's.
        stored = { ...(stored as StoredTokens), expiresAt: null };
        let resolveFetch!: (value: Response) => void;
        const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
        const fetchImpl = vi.fn(() => pending);

        const provider = build(fetchImpl as unknown as typeof fetch);
        const callers = Promise.all([provider.get(), provider.get(), provider.get()]);
        resolveFetch(jsonResponse(200, { access_token: 'one', refresh_token: 'r', expires_in: 14_400 }));

        expect(await callers).toEqual(['one', 'one', 'one']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
