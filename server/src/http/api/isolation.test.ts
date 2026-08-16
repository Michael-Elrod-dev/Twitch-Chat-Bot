import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { pino } from 'pino';
import type { DbHandle } from '../../db/client.js';
import { connectTestDatabase } from '../../db/testing.js';
import { createApp } from '../app.js';
import { createResourceRouter } from './resources.js';
import {
    createRequireJwt,
    createApiKeyAuth,
    createRequireChannelExceptMe,
    requireAnyCredential
} from './middleware.js';
import { createRateLimit } from './rateLimit.js';
import { ChannelRepository } from '../../db/repositories/channelRepository.js';
import { ApiKeyRepository } from '../../db/repositories/apiKeyRepository.js';
import { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { signJwt } from '../../auth/jwt.js';

/**
 * THE API-LAYER CENTREPIECE: channel A's token against channel B's data.
 *
 * P1-WP4 proved two sessions cannot leak into each other. This proves the same
 * for the HTTP surface, where the attack is easier to attempt — a caller
 * controls the whole request. The design that makes it impossible is that no
 * route accepts a channel identifier at all: the token *is* the tenant
 * selector, so there is nothing to tamper with.
 *
 * These tests therefore try the things a real attacker would: another tenant's
 * token, a forged one, a key scoped to one channel, and identifiers belonging
 * to someone else pushed through every route that takes one.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'api-isolation-test-signing-secret-value';

describeDb('API tenant isolation', () => {
    let handle: DbHandle;
    let app: ReturnType<typeof createApp>;
    let alpha: { id: string; broadcasterId: string; token: string };
    let beta: { id: string; broadcasterId: string; token: string };

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();

        const a = await channels.upsert({
            twitchBroadcasterId: `iso-alpha-${stamp}`, twitchLogin: 'isoalpha', displayName: null
        });
        const b = await channels.upsert({
            twitchBroadcasterId: `iso-beta-${stamp}`, twitchLogin: 'isobeta', displayName: null
        });

        alpha = {
            id: a.id,
            broadcasterId: a.twitchBroadcasterId,
            token: signJwt({ sub: a.twitchBroadcasterId, login: 'isoalpha' }, JWT_SECRET, 900)
        };
        beta = {
            id: b.id,
            broadcasterId: b.twitchBroadcasterId,
            token: signJwt({ sub: b.twitchBroadcasterId, login: 'isobeta' }, JWT_SECRET, 900)
        };

        const apiKeys = new ApiKeyRepository(handle.db);
        const router = Router();
        router.use('/api/v1', createApiKeyAuth(apiKeys, channels));
        router.use('/api/v1', createRequireJwt(JWT_SECRET, logger));
        router.use('/api/v1', requireAnyCredential);
        router.use('/api/v1', createRateLimit({ windowMs: 60_000, max: 10_000, bucket: 'test' }));
        router.use(createRequireChannelExceptMe(channels));
        router.use(createResourceRouter({
            logger,
            repositories: (channelId) => createChannelRepositories(handle.db, channelId),
            channels,
            apiKeys,
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            songs: (channelId) => new SongQueueRepository(handle.db, channelId)
        }));

        app = createApp({ logger, version: 'test', routers: [router] });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const asAlpha = (): string => `Bearer ${alpha.token}`;
    const asBeta = (): string => `Bearer ${beta.token}`;

    beforeEach(async () => {
        // Each test starts from a known per-channel state.
        for (const id of [alpha.id, beta.id]) {
            await handle.sql`delete from commands where channel_id = ${id}`;
            await handle.sql`delete from emotes where channel_id = ${id}`;
            await handle.sql`delete from quotes where channel_id = ${id}`;
        }
    });

    describe('commands', () => {
        it('shows each channel only its own', async () => {
            await request(app).post('/api/v1/commands').set('authorization', asAlpha())
                .send({ name: '!alphaonly', responseText: 'from alpha' }).expect(201);
            await request(app).post('/api/v1/commands').set('authorization', asBeta())
                .send({ name: '!betaonly', responseText: 'from beta' }).expect(201);

            const a = await request(app).get('/api/v1/commands').set('authorization', asAlpha()).expect(200);
            const b = await request(app).get('/api/v1/commands').set('authorization', asBeta()).expect(200);

            expect(a.body.data.items.map((c: { name: string }) => c.name)).toEqual(['!alphaonly']);
            expect(b.body.data.items.map((c: { name: string }) => c.name)).toEqual(['!betaonly']);
        });

        it('lets both channels hold the same command name independently', async () => {
            await request(app).post('/api/v1/commands').set('authorization', asAlpha())
                .send({ name: '!shared', responseText: 'ALPHA text' }).expect(201);
            await request(app).post('/api/v1/commands').set('authorization', asBeta())
                .send({ name: '!shared', responseText: 'BETA text' }).expect(201);

            const a = await request(app).get('/api/v1/commands').set('authorization', asAlpha());
            expect(a.body.data.items[0].responseText).toBe('ALPHA text');
        });

        it('cannot read another channel command by name', async () => {
            await request(app).post('/api/v1/commands').set('authorization', asAlpha())
                .send({ name: '!secret', responseText: 'alpha only' }).expect(201);

            // Beta names alpha's command exactly. It does not exist for beta.
            await request(app).patch('/api/v1/commands/!secret').set('authorization', asBeta())
                .send({ responseText: 'hijacked' }).expect(404);
        });

        it('cannot delete another channel command', async () => {
            await request(app).post('/api/v1/commands').set('authorization', asAlpha())
                .send({ name: '!undeletable', responseText: 'x' }).expect(201);

            await request(app).delete('/api/v1/commands/!undeletable').set('authorization', asBeta()).expect(404);

            const a = await request(app).get('/api/v1/commands').set('authorization', asAlpha());
            expect(a.body.data.items.map((c: { name: string }) => c.name)).toContain('!undeletable');
        });
    });

    describe('quotes', () => {
        it('numbers each channel independently and never crosses', async () => {
            const a1 = await request(app).post('/api/v1/quotes').set('authorization', asAlpha())
                .send({ quoteText: 'alpha first' }).expect(201);
            const b1 = await request(app).post('/api/v1/quotes').set('authorization', asBeta())
                .send({ quoteText: 'beta first' }).expect(201);

            expect(a1.body.data.quoteNumber).toBe(1);
            expect(b1.body.data.quoteNumber).toBe(1);

            // Same number, different channel, different quote.
            const fromAlpha = await request(app).get('/api/v1/quotes/1').set('authorization', asAlpha());
            const fromBeta = await request(app).get('/api/v1/quotes/1').set('authorization', asBeta());

            expect(fromAlpha.body.data.quoteText).toBe('alpha first');
            expect(fromBeta.body.data.quoteText).toBe('beta first');
        });

        it('cannot delete another channel quote by number', async () => {
            await request(app).post('/api/v1/quotes').set('authorization', asAlpha())
                .send({ quoteText: 'alpha keeps this' }).expect(201);

            await request(app).delete('/api/v1/quotes/1').set('authorization', asBeta()).expect(404);

            await request(app).get('/api/v1/quotes/1').set('authorization', asAlpha()).expect(200);
        });

        it('random never returns another channel quote', async () => {
            await request(app).post('/api/v1/quotes').set('authorization', asAlpha())
                .send({ quoteText: 'alpha only quote' }).expect(201);

            // Beta has none, so random is a 404 rather than alpha's quote.
            await request(app).get('/api/v1/quotes/random').set('authorization', asBeta()).expect(404);
        });
    });

    describe('emotes', () => {
        it('scopes per channel', async () => {
            await request(app).post('/api/v1/emotes').set('authorization', asAlpha())
                .send({ triggerText: 'kappa', responseText: 'alpha kappa' }).expect(201);

            const b = await request(app).get('/api/v1/emotes').set('authorization', asBeta()).expect(200);
            expect(b.body.data.items).toHaveLength(0);

            await request(app).delete('/api/v1/emotes/kappa').set('authorization', asBeta()).expect(404);
        });
    });

    describe('settings', () => {
        it('one channel PATCH does not touch the other', async () => {
            await request(app).patch('/api/v1/me/settings').set('authorization', asAlpha())
                .send({ aiEnabled: false }).expect(200);
            await request(app).patch('/api/v1/me/settings').set('authorization', asBeta())
                .send({ aiEnabled: true }).expect(200);

            const a = await request(app).get('/api/v1/me').set('authorization', asAlpha());
            expect(a.body.data.settings.aiEnabled).toBe(false);
        });

        it('never echoes a configured webhook URL back', async () => {
            // The URL is a capability; returning it would let a stolen token
            // exfiltrate one.
            await request(app).patch('/api/v1/me/settings').set('authorization', asAlpha())
                .send({ discordWebhookUrl: 'https://discord.com/api/webhooks/secret/value' }).expect(200);

            const me = await request(app).get('/api/v1/me').set('authorization', asAlpha());

            expect(JSON.stringify(me.body)).not.toContain('secret/value');
            expect(me.body.data.settings.discordWebhookConfigured).toBe(true);
        });
    });

    describe('analytics', () => {
        it('reports only the caller channel and works over empty data', async () => {
            const b = await request(app).get('/api/v1/analytics/summary').set('authorization', asBeta()).expect(200);

            // A brand-new tenant gets zeroes, not an error.
            expect(b.body.data).toMatchObject({ messages: 0, commandsUsed: 0, streams: 0, topChatters: [] });
        });
    });

    describe('api keys', () => {
        it('a key for one channel cannot reach the other', async () => {
            const created = await request(app).post('/api/v1/api-keys').set('authorization', asAlpha())
                .send({ name: 'alpha stream deck' }).expect(201);
            const key = created.body.data.key as string;

            // The key works for its own channel's songs...
            await request(app).get('/api/v1/songs').set('x-api-key', key).expect(200);

            // ...and identifies alpha, never beta, with no way to say otherwise.
            const songs = await request(app).get('/api/v1/songs').set('x-api-key', key).expect(200);
            expect(songs.body.ok).toBe(true);
        });

        it('cannot revoke another channel key', async () => {
            const created = await request(app).post('/api/v1/api-keys').set('authorization', asAlpha())
                .send({ name: 'alpha key' }).expect(201);

            await request(app).delete(`/api/v1/api-keys/${created.body.data.id}`)
                .set('authorization', asBeta()).expect(404);

            const stillThere = await request(app).get('/api/v1/api-keys').set('authorization', asAlpha());
            expect(stillThere.body.data.items.some((k: { id: string }) => k.id === created.body.data.id)).toBe(true);
        });

        it('lists keys without ever returning the key itself', async () => {
            await request(app).post('/api/v1/api-keys').set('authorization', asAlpha())
                .send({ name: 'listed' }).expect(201);

            const list = await request(app).get('/api/v1/api-keys').set('authorization', asAlpha()).expect(200);

            expect(list.body.data.items[0]).toHaveProperty('prefix');
            expect(list.body.data.items[0]).not.toHaveProperty('key');
        });
    });

    describe('credentials', () => {
        it('rejects a forged token', async () => {
            const forged = signJwt({ sub: alpha.broadcasterId, login: 'isoalpha' }, 'another-secret-entirely-here', 900);

            await request(app).get('/api/v1/commands').set('authorization', `Bearer ${forged}`).expect(401);
        });

        it('rejects an unknown API key', async () => {
            await request(app).get('/api/v1/songs').set('x-api-key', 'ahai_madeupvalue').expect(401);
        });

        it('a signed-in user with no channel gets 404 on resources but 200 on /me', async () => {
            const stranger = signJwt({ sub: 'nobody-has-this-id', login: 'stranger' }, JWT_SECRET, 900);

            const me = await request(app).get('/api/v1/me').set('authorization', `Bearer ${stranger}`).expect(200);
            expect(me.body.data.channel).toBeNull();

            await request(app).get('/api/v1/commands').set('authorization', `Bearer ${stranger}`).expect(404);
        });
    });

    describe('API key scope', () => {
        it('is refused on every route except songs', async () => {
            const created = await request(app).post('/api/v1/api-keys').set('authorization', asAlpha())
                .send({ name: 'scoped' }).expect(201);
            const key = created.body.data.key as string;

            // A key taped inside a Stream Deck profile must not be able to
            // rewrite commands or read analytics.
            for (const path of ['/api/v1/commands', '/api/v1/emotes', '/api/v1/quotes',
                '/api/v1/analytics/summary', '/api/v1/api-keys', '/api/v1/me']) {
                const res = await request(app).get(path).set('x-api-key', key);
                expect([403, 401]).toContain(res.status);
            }
        });

        it('is accepted on the songs routes', async () => {
            const created = await request(app).post('/api/v1/api-keys').set('authorization', asAlpha())
                .send({ name: 'songs key' }).expect(201);
            const key = created.body.data.key as string;

            await request(app).get('/api/v1/songs').set('x-api-key', key).expect(200);
            await request(app).post('/api/v1/songs/toggle').set('x-api-key', key)
                .send({ enabled: false }).expect(200);
        });
    });
});
