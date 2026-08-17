import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from './app.js';
import { Router } from 'express';
import { createAuthRouter, AUTH_CALLBACK_PATH } from './authRoutes.js';
import { createResourceRouter } from './api/resources.js';
import {
    createRequireJwt,
    createRequireChannelExceptMe,
    requireAnyCredential
} from './api/middleware.js';
import { createStateStore, type StateStore } from '../auth/stateStore.js';
import { TwitchOAuthClient, CHANNEL_SCOPES, BOT_SCOPES } from '../twitch/oauth.js';
import type { OnboardingService } from '../auth/onboarding.js';
import type { AppSessionRepository, AppSession } from '../db/repositories/appSessionRepository.js';
import type { ChannelRepository } from '../db/repositories/channelRepository.js';
import type { ChannelRepositories } from '../bootstrap.js';
import type { CacheManager } from '../cache/cacheManager.js';
import { signJwt, hashRefreshToken } from '../auth/jwt.js';

/**
 * The OAuth surface is where a mistake hands someone else's Twitch account to
 * this server, so these tests are written from the attacker's side: forged
 * callbacks, replayed state, and stolen refresh tokens.
 */

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'a-test-signing-secret-of-sufficient-length';
const AUTH_CODE = 'super-secret-authorization-code';

const nullCache = (): CacheManager =>
    ({ getJson: async () => null, setJson: async () => true, del: async () => true }) as unknown as CacheManager;

interface Harness {
    app: ReturnType<typeof createApp>;
    states: StateStore;
    onboardedChannels: { login: string }[];
    botConsents: { login: string }[];
    sessions: Map<string, AppSession>;
    revoked: string[];
    fetchCalls: string[];
    spotifyConnected: { twitchUserId: string }[];
}

function buildHarness(overrides: {
    configured?: boolean;
    jwtSecret?: string | undefined;
    tokenExchangeStatus?: number;
    /** Lets a test sign in as the wrong Twitch account. */
    identityUserId?: string;
    identityLogin?: string;
    returnToPolicy?: { allowLoopback: boolean };
} = {}): Harness {
    const onboardedChannels: { login: string }[] = [];
    const botConsents: { login: string }[] = [];
    const sessions = new Map<string, AppSession>();
    const revoked: string[] = [];
    const fetchCalls: string[] = [];
    const spotifyConnected: { twitchUserId: string }[] = [];

    const fetchImpl = (async (url: string | URL | Request) => {
        const target = String(url);
        fetchCalls.push(target);

        if (target.includes('/oauth2/token')) {
            const status = overrides.tokenExchangeStatus ?? 200;
            return new Response(JSON.stringify(status === 200
                ? { access_token: 'twitch-access', refresh_token: 'twitch-refresh', expires_in: 14_400, scope: [...CHANNEL_SCOPES] }
                : { message: 'Invalid authorization code' }
            ), { status });
        }
        if (target.includes('accounts.spotify.com/api/token')) {
            return new Response(JSON.stringify({
                access_token: 'spotify-access', refresh_token: 'spotify-refresh',
                expires_in: 3600, scope: 'user-read-playback-state'
            }), { status: 200 });
        }
        if (target.includes('/oauth2/validate')) {
            return new Response(JSON.stringify({
                user_id: overrides.identityUserId ?? '1001',
                login: overrides.identityLogin ?? 'aimosthadme',
                scopes: [...CHANNEL_SCOPES],
                expires_in: 14_400
            }), { status: 200 });
        }
        if (target.includes('/oauth2/revoke')) {
            revoked.push(target);
            return new Response(null, { status: 200 });
        }
        return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const oauth = new TwitchOAuthClient({
        config: { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/auth/twitch/callback' },
        logger,
        fetchImpl
    });

    const states = createStateStore(nullCache());

    const onboarding = {
        onboardChannel: vi.fn(async (identity: { login: string }) => {
            onboardedChannels.push({ login: identity.login });
            return { channel: { id: 'c1', twitchLogin: identity.login }, missingScopes: [], sessionStarted: true };
        }),
        recordBotConsent: vi.fn(async (identity: { login: string }) => {
            botConsents.push({ login: identity.login });
            return { missingScopes: [] };
        })
    } as unknown as OnboardingService;

    const sessionRepo = {
        create: async (token: string, session: AppSession) => { sessions.set(hashRefreshToken(token), session); },
        resolve: async (token: string) => sessions.get(hashRefreshToken(token)) ?? null,
        revoke: async (token: string) => sessions.delete(hashRefreshToken(token))
    } as unknown as AppSessionRepository;

    // A full ChannelRecord: `enabled` is part of the shape `/me` reports, and
    // a fixture missing it is how the old stub's answer drifted from the real
    // one without anything noticing.
    const channels = {
        findByBroadcasterId: async (id: string) =>
            (id === '1001'
                ? {
                    id: 'c1', twitchBroadcasterId: '1001', twitchLogin: 'aimosthadme',
                    status: 'active', enabled: true
                }
                : null)
    } as unknown as ChannelRepository;

    const authRouter = createAuthRouter({
        oauth, states, onboarding, sessions: sessionRepo, logger,
        channels,
        jwtSecret: 'jwtSecret' in overrides ? overrides.jwtSecret : JWT_SECRET,
        jwtTtlSeconds: 900,
        configured: overrides.configured ?? true,
        returnToPolicy: overrides.returnToPolicy ?? { allowLoopback: false },
        spotify: {
            config: {
                clientId: 'spotify-client',
                clientSecret: 'spotify-secret',
                redirectUri: 'https://x.test/auth/spotify/callback'
            },
            onConnected: async (twitchUserId) => { spotifyConnected.push({ twitchUserId }); },
            fetchImpl
        }
    });

    /*
     * The REAL API router, not a stand-in.
     *
     * These tests are about the auth chain — a forged token, an expired one, a
     * server with no signing key — but the thing the chain is protecting has to
     * be the thing production actually serves, or the test proves the guard on
     * a door nobody uses. The WP6 stub that used to sit here had already
     * drifted from `/me`'s real shape by the time it was removed.
     */
    const apiRouter = Router();
    apiRouter.use('/api/v1', createRequireJwt(
        'jwtSecret' in overrides ? overrides.jwtSecret : JWT_SECRET,
        logger
    ));
    apiRouter.use('/api/v1', requireAnyCredential);
    apiRouter.use(createRequireChannelExceptMe(channels));
    apiRouter.use(createResourceRouter({
        logger,
        repositories: () => ({
            settings: { get: async () => null }
        }) as unknown as ChannelRepositories,
        channels,
        apiKeys: {} as never,
        analytics: () => ({}) as never,
        dashboard: () => ({}) as never,
        songs: () => ({}) as never
    }));

    return {
        app: createApp({ logger, version: 'test', routers: [authRouter, apiRouter] }),
        states, onboardedChannels, botConsents, sessions, revoked, fetchCalls, spotifyConnected
    };
}

describe('OAuth flow start', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    it('redirects the broadcaster to consent with all five scopes', async () => {
        const response = await request(harness.app).get('/auth/twitch/connect').expect(302);
        const location = new URL(response.headers['location'] as string);

        expect(location.origin).toBe('https://id.twitch.tv');
        expect(location.searchParams.get('scope')?.split(' ').sort()).toEqual([...CHANNEL_SCOPES].sort());
        expect(location.searchParams.get('response_type')).toBe('code');
    });

    it('redirects the bot account to its three global scopes', async () => {
        const response = await request(harness.app).get('/auth/bot/connect').expect(302);
        const location = new URL(response.headers['location'] as string);

        expect(location.searchParams.get('scope')?.split(' ').sort()).toEqual([...BOT_SCOPES].sort());
    });

    it('requests no scopes at all for sign-in', async () => {
        // Signing in proves identity; asking for access the app never uses is
        // how applications get suspended.
        const response = await request(harness.app).get('/auth/app/login').expect(302);

        expect(new URL(response.headers['location'] as string).searchParams.get('scope')).toBe('');
    });

    it('never puts the client secret in the redirect', async () => {
        const response = await request(harness.app).get('/auth/twitch/connect').expect(302);

        expect(response.headers['location']).not.toContain('client-secret');
    });

    it('issues a distinct state per flow start', async () => {
        const first = await request(harness.app).get('/auth/twitch/connect');
        const second = await request(harness.app).get('/auth/twitch/connect');

        const stateOf = (r: typeof first): string =>
            new URL(r.headers['location'] as string).searchParams.get('state') ?? '';

        expect(stateOf(first)).not.toBe(stateOf(second));
        expect(stateOf(first).length).toBeGreaterThan(20);
    });

    it('answers 503 when Twitch credentials are absent', async () => {
        const unconfigured = buildHarness({ configured: false });

        await request(unconfigured.app).get('/auth/twitch/connect').expect(503);
    });
});

describe('OAuth callback', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    const startAndGetState = async (path: string): Promise<string> => {
        const response = await request(harness.app).get(path).expect(302);
        return new URL(response.headers['location'] as string).searchParams.get('state') as string;
    };

    describe('CSRF protection', () => {
        it('refuses a callback with no state', async () => {
            await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}`).expect(403);

            expect(harness.onboardedChannels).toHaveLength(0);
        });

        it('refuses a state the server never issued', async () => {
            // Without this, a crafted callback carrying an attacker's code would
            // attach their Twitch account to this server.
            await request(harness.app)
                .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=made-up-value`)
                .expect(403);

            expect(harness.onboardedChannels).toHaveLength(0);
        });

        it('refuses a replayed state', async () => {
            const state = await startAndGetState('/auth/twitch/connect');

            await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(200);
            await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(403);

            expect(harness.onboardedChannels).toHaveLength(1);
        });

        it('checks the state before spending the code', async () => {
            // Spending first would defeat the whole defence: the code is consumed
            // and the attacker learns the exchange succeeded.
            await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=bogus`).expect(403);

            expect(harness.fetchCalls.filter((c) => c.includes('/oauth2/token'))).toHaveLength(0);
        });

        it('never echoes the authorization code back to the caller', async () => {
            const response = await request(harness.app)
                .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=bogus`);

            expect(response.text).not.toContain(AUTH_CODE);
        });
    });

    it('onboards the channel on the channel flow', async () => {
        const state = await startAndGetState('/auth/twitch/connect');

        const response = await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
            .expect(200);

        expect(harness.onboardedChannels).toEqual([{ login: 'aimosthadme' }]);
        expect(response.text).toContain('aimosthadme');
        expect(response.text).not.toContain(AUTH_CODE);
    });

    it('records bot consent on the bot flow', async () => {
        const state = await startAndGetState('/auth/bot/connect');

        await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(200);

        expect(harness.botConsents).toEqual([{ login: 'aimosthadme' }]);
        expect(harness.onboardedChannels).toHaveLength(0);
    });

    it('routes by the state the server issued, not by anything the caller sends', async () => {
        // The flow cannot be selected from outside - a bot-flow callback cannot
        // be turned into a channel onboarding.
        const botState = await startAndGetState('/auth/bot/connect');

        await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${botState}`).expect(200);

        expect(harness.onboardedChannels).toHaveLength(0);
    });

    it('reports a declined consent screen without touching anything', async () => {
        await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?error=access_denied&error_description=denied`)
            .expect(400);

        expect(harness.onboardedChannels).toHaveLength(0);
    });

    it('rejects a state with no code', async () => {
        const state = await startAndGetState('/auth/twitch/connect');

        await request(harness.app).get(`${AUTH_CALLBACK_PATH}?state=${state}`).expect(400);
    });

    it('reports a code Twitch refuses as a 400, not a server error', async () => {
        // An expired or already-spent code is the user's problem to retry.
        // A 500 would send someone hunting a bug that is not there.
        const rejecting = buildHarness({ tokenExchangeStatus: 400 });
        const start = await request(rejecting.app).get('/auth/twitch/connect').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const response = await request(rejecting.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
            .expect(400);

        expect(response.text).not.toContain(AUTH_CODE);
    });

    it('consumes the state even when the exchange fails', async () => {
        // A CSRF token is single-use regardless of outcome; restarting the flow
        // is cheap, and a reusable state is not.
        const rejecting = buildHarness({ tokenExchangeStatus: 400 });
        const start = await request(rejecting.app).get('/auth/twitch/connect').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        await request(rejecting.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(400);
        await request(rejecting.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(403);
    });

    describe('sign-in', () => {
        it('issues an access token and a refresh token', async () => {
            const state = await startAndGetState('/auth/app/login');

            const response = await request(harness.app)
                .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.data.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
            expect(response.body.data.refresh_token.length).toBeGreaterThan(20);
        });

        it('discards the Twitch token immediately', async () => {
            // Sign-in wants identity and nothing else, so the app never holds a
            // Twitch credential it has no use for.
            const state = await startAndGetState('/auth/app/login');
            await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`).expect(200);

            expect(harness.revoked).toHaveLength(1);
        });

        it('never returns a Twitch token to the caller', async () => {
            const state = await startAndGetState('/auth/app/login');
            const response = await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`);

            expect(JSON.stringify(response.body)).not.toContain('twitch-access');
            expect(JSON.stringify(response.body)).not.toContain('twitch-refresh');
        });
    });
});

describe('refresh and logout', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    const signIn = async (): Promise<{ accessToken: string; refreshToken: string }> => {
        const start = await request(harness.app).get('/auth/app/login').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
        const response = await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`);
        return { accessToken: response.body.data.access_token, refreshToken: response.body.data.refresh_token };
    };

    it('exchanges a refresh token for a new pair', async () => {
        const { refreshToken } = await signIn();

        const response = await request(harness.app)
            .post('/auth/app/refresh').send({ refresh_token: refreshToken })
            .expect(200);

        expect(response.body.data.access_token).toBeTruthy();
        expect(response.body.data.refresh_token).not.toBe(refreshToken);
    });

    it('rotates: the old refresh token stops working', async () => {
        // A stolen refresh token is usable at most once, and its use is visible
        // because the legitimate holder's next attempt fails.
        const { refreshToken } = await signIn();

        await request(harness.app).post('/auth/app/refresh').send({ refresh_token: refreshToken }).expect(200);
        await request(harness.app).post('/auth/app/refresh').send({ refresh_token: refreshToken }).expect(401);
    });

    it('rejects an unknown refresh token', async () => {
        await request(harness.app).post('/auth/app/refresh').send({ refresh_token: 'invented' }).expect(401);
    });

    it('requires a refresh token', async () => {
        await request(harness.app).post('/auth/app/refresh').send({}).expect(400);
    });

    it('logs out and invalidates the token', async () => {
        const { refreshToken } = await signIn();

        await request(harness.app).post('/auth/app/logout').send({ refresh_token: refreshToken }).expect(204);
        await request(harness.app).post('/auth/app/refresh').send({ refresh_token: refreshToken }).expect(401);
    });

    it('answers logout identically for an unknown token', async () => {
        // Whether a token existed is not the caller's business.
        await request(harness.app).post('/auth/app/logout').send({ refresh_token: 'invented' }).expect(204);
    });
});

describe('/api/v1/me', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    it('rejects an unauthenticated request', async () => {
        await request(harness.app).get('/api/v1/me').expect(401);
    });

    it('rejects a non-bearer authorization header', async () => {
        await request(harness.app).get('/api/v1/me').set('authorization', 'Basic abc').expect(401);
    });

    it('rejects a forged token', async () => {
        const forged = signJwt({ sub: '1001', login: 'attacker' }, 'a-completely-different-secret-here', 900);

        await request(harness.app).get('/api/v1/me').set('authorization', `Bearer ${forged}`).expect(401);
    });

    it('rejects an expired token', async () => {
        const expired = signJwt({ sub: '1001', login: 'x' }, JWT_SECRET, 60, Date.now() - 120_000);

        await request(harness.app).get('/api/v1/me').set('authorization', `Bearer ${expired}`).expect(401);
    });

    it('gives the same answer for a forged and an expired token', async () => {
        // Telling a caller which one failed is free reconnaissance.
        const forged = signJwt({ sub: '1', login: 'x' }, 'another-secret-entirely-here-ok', 900);
        const expired = signJwt({ sub: '1', login: 'x' }, JWT_SECRET, 60, Date.now() - 120_000);

        const a = await request(harness.app).get('/api/v1/me').set('authorization', `Bearer ${forged}`);
        const b = await request(harness.app).get('/api/v1/me').set('authorization', `Bearer ${expired}`);

        expect(a.body).toEqual(b.body);
    });

    it('returns the caller and their connected channel', async () => {
        const token = signJwt({ sub: '1001', login: 'aimosthadme' }, JWT_SECRET, 900);

        const response = await request(harness.app)
            .get('/api/v1/me').set('authorization', `Bearer ${token}`)
            .expect(200);

        expect(response.body.data).toMatchObject({
            twitchUserId: '1001',
            login: 'aimosthadme',
            channel: { id: 'c1', login: 'aimosthadme', status: 'active' }
        });
    });

    it('returns a null channel for a signed-in user who has connected none', async () => {
        // An ordinary state, not a failure.
        const token = signJwt({ sub: '9999', login: 'stranger' }, JWT_SECRET, 900);

        const response = await request(harness.app)
            .get('/api/v1/me').set('authorization', `Bearer ${token}`)
            .expect(200);

        expect(response.body.data.channel).toBeNull();
    });

    it('fails closed when no signing key is configured', async () => {
        // A server that cannot verify must reject, not wave requests through.
        const unsigned = buildHarness({ jwtSecret: undefined });

        await request(unsigned.app).get('/api/v1/me').set('authorization', 'Bearer anything').expect(503);
    });
});

describe('end-to-end sign-in to guarded resource', () => {
    it('carries a real sign-in through to an authenticated call', async () => {
        const harness = buildHarness();

        const start = await request(harness.app).get('/auth/app/login').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
        const callback = await request(harness.app).get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`);

        const response = await request(harness.app)
            .get('/api/v1/me')
            .set('authorization', `Bearer ${callback.body.data.access_token}`)
            .expect(200);

        expect(response.body.data.login).toBe('aimosthadme');
    });
});

describe('Spotify connect in a plain browser', () => {
    /**
     * As first shipped this flow could not be completed by a human: it demanded
     * a bearer token a browser cannot attach to a link it was handed, and the
     * sign-in returned its token in a URL fragment only a desktop app could
     * read. This is the broadcaster's onboarding path, so the bar is one click
     * and no token handling.
     */
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    it('bounces an unauthenticated visitor through Twitch sign-in', async () => {
        const response = await request(harness.app).get('/auth/spotify/connect').expect(302);
        const location = new URL(response.headers['location'] as string);

        // Twitch first, not the 401 that stopped the owner.
        expect(location.origin).toBe('https://id.twitch.tv');
        expect(location.searchParams.get('scope')).toBe('');
    });

    it('continues to Spotify after sign-in, handing the browser no token', async () => {
        const start = await request(harness.app).get('/auth/spotify/connect').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const afterSignIn = await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
            .expect(302);

        expect(new URL(afterSignIn.headers['location'] as string).origin).toBe('https://accounts.spotify.com');
        expect(afterSignIn.headers['location']).not.toContain('access_token');
    });

    it('completes the whole journey in one click', async () => {
        const start = await request(harness.app).get('/auth/spotify/connect').expect(302);
        const signInState = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const toSpotify = await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${signInState}`)
            .expect(302);
        const spotifyState = new URL(toSpotify.headers['location'] as string).searchParams.get('state') as string;

        await request(harness.app)
            .get(`/auth/spotify/callback?code=spotify-code&state=${spotifyState}`)
            .expect(200);

        expect(harness.spotifyConnected).toEqual([{ twitchUserId: '1001' }]);
    });

    it('names the wrong Twitch account rather than connecting the wrong channel', async () => {
        // The easy mistake, because the consent flows leave the BOT account
        // signed in to Twitch in that browser.
        const stranger = buildHarness({ identityUserId: '9999', identityLogin: 'almosthadai' });

        const start = await request(stranger.app).get('/auth/spotify/connect').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const response = await request(stranger.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
            .expect(400);

        expect(response.text).toContain('almosthadai');
        expect(response.text).toContain('no connected channel');
        expect(stranger.spotifyConnected).toHaveLength(0);
    });

    it('refuses a forged Spotify callback state', async () => {
        await request(harness.app).get('/auth/spotify/callback?code=x&state=invented').expect(403);

        expect(harness.spotifyConnected).toHaveLength(0);
    });

    it('refuses a Twitch-flow state replayed at the Spotify callback', async () => {
        // Flows are not interchangeable: a channel-connect state must not be
        // spendable as a Spotify one.
        const start = await request(harness.app).get('/auth/twitch/connect').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        await request(harness.app).get(`/auth/spotify/callback?code=x&state=${state}`).expect(403);
    });

    it('still issues tokens for an ordinary sign-in with no continuation', async () => {
        // The chained path must not have broken the desktop app's flow.
        const start = await request(harness.app).get('/auth/app/login').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const response = await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}`)
            .expect(200);

        expect(response.body.data.access_token).toBeTruthy();
    });
});

describe('the continuation cannot be chosen by the caller', () => {
    it('ignores a `then` query parameter on the callback', async () => {
        /*
         * The continuation lives in the server-issued state, never in the
         * request. If a caller could ask to be forwarded, they could aim a
         * completed sign-in at any flow the server supports - so a plausible
         * future "convenience" edit reading it from the query string is a
         * regression this pins.
         */
        const harness = buildHarness();

        const start = await request(harness.app).get('/auth/app/login').expect(302);
        const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

        const response = await request(harness.app)
            .get(`${AUTH_CALLBACK_PATH}?code=${AUTH_CODE}&state=${state}&then=spotify`)
            .expect(200);

        // Tokens, not a redirect to Spotify.
        expect(response.body.data.access_token).toBeTruthy();
        expect(harness.spotifyConnected).toHaveLength(0);
    });
});


describe('return_to is not an open redirect', () => {
    /**
     * The vulnerability: `return_to` went unvalidated from the query string into
     * `res.redirect()` alongside a live access AND refresh token in the
     * fragment. Any URL an attacker could get a user to click handed over a
     * working session, invisibly - a fragment reaches no server log.
     *
     * Tested at the route rather than only on the helper, because the helper
     * being correct is worth nothing if the route forgets to call it.
     */
    it('refuses to start a flow aimed at an attacker', async () => {
        const { app } = buildHarness();

        const response = await request(app)
            .get('/auth/app/login')
            .query({ return_to: 'https://evil.example/steal' });

        expect(response.status).toBe(400);
        // Refused before Twitch is involved at all.
        expect(response.headers['location']).toBeUndefined();
    });

    it('starts a flow aimed at the desktop app', async () => {
        const { app } = buildHarness();

        const response = await request(app)
            .get('/auth/app/login')
            .query({ return_to: 'almosthadai://auth' });

        expect(response.status).toBe(302);
        expect(response.headers['location']).toContain('id.twitch.tv');
    });

    it('still allows a flow with no return_to at all', async () => {
        const { app } = buildHarness();

        const response = await request(app).get('/auth/app/login');

        expect(response.status).toBe(302);
    });

    it('refuses loopback unless development has enabled it', async () => {
        const strict = buildHarness();
        expect((await request(strict.app)
            .get('/auth/app/login')
            .query({ return_to: 'http://localhost:1420/cb' })).status).toBe(400);

        const permissive = buildHarness({ returnToPolicy: { allowLoopback: true } });
        expect((await request(permissive.app)
            .get('/auth/app/login')
            .query({ return_to: 'http://localhost:1420/cb' })).status).toBe(302);
    });
});
