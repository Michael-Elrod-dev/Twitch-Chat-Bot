import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { ChannelRepository } from '../../db/repositories/channelRepository.js';
import { ApiKeyRepository } from '../../db/repositories/apiKeyRepository.js';
import { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { DashboardRepository } from '../../db/repositories/dashboardRepository.js';
import { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { signJwt } from '../../auth/jwt.js';
import { SessionManager } from '../../session/sessionManager.js';
import { FakeTransport } from '../../transport/fakeTransport.js';
import { ChannelSession } from '../../session/channelSession.js';
import { applyChannelEnabled, type ChannelSwitchPorts } from '../../session/channelSwitch.js';

/**
 * The bot master switch, end to end.
 *
 * Wired against a REAL SessionManager rather than a spy on purpose: the whole
 * point of the switch is that flipping it starts and stops a session, and a
 * test that only asserted "the seam was called" would stay green if the seam
 * were wired to nothing. The transport is the fake one so subscriptions are
 * observable, but everything between the HTTP request and `SessionManager` is
 * the production path.
 *
 * The distinction under test throughout is `enabled` vs `status`: what the
 * owner chose versus what the world did to the channel. Every assertion that
 * checks one of them also checks the other has not moved.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'channel-switch-test-signing-secret-value';

describeDb('channel master switch', () => {
    let handle: DbHandle;
    let channels: ChannelRepository;
    let apiKeys: ApiKeyRepository;
    let app: ReturnType<typeof createApp>;
    let manager: SessionManager;
    let transport: FakeTransport;
    let alpha: { id: string; broadcasterId: string; token: string };
    let beta: { id: string; broadcasterId: string; token: string };

    const buildSession = (channel: { id: string; twitchBroadcasterId: string }): ChannelSession =>
        new ChannelSession({
            channelId: channel.id,
            broadcasterTwitchId: channel.twitchBroadcasterId,
            logger,
            pipeline: { handle: vi.fn(async () => ({ action: 'none' as const })) } as never,
            commands: { load: vi.fn(async () => undefined) } as never,
            emotes: { load: vi.fn(async () => undefined) } as never
        });

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        channels = new ChannelRepository(handle.db);
        apiKeys = new ApiKeyRepository(handle.db);
        const stamp = Date.now();

        const a = await channels.upsert({
            twitchBroadcasterId: `sw-alpha-${stamp}`, twitchLogin: 'swalpha', displayName: null
        });
        const b = await channels.upsert({
            twitchBroadcasterId: `sw-beta-${stamp}`, twitchLogin: 'swbeta', displayName: null
        });

        alpha = {
            id: a.id,
            broadcasterId: a.twitchBroadcasterId,
            token: signJwt({ sub: a.twitchBroadcasterId, login: 'swalpha' }, JWT_SECRET, 900)
        };
        beta = {
            id: b.id,
            broadcasterId: b.twitchBroadcasterId,
            token: signJwt({ sub: b.twitchBroadcasterId, login: 'swbeta' }, JWT_SECRET, 900)
        };

        transport = new FakeTransport();
        manager = new SessionManager({ transport, logger });
        await manager.start();

        const ports: ChannelSwitchPorts = {
            listActive: () => channels.listActive(),
            sessions: manager,
            buildSession
        };

        const router = Router();
        router.use('/api/v1', createApiKeyAuth(apiKeys, channels));
        router.use('/api/v1', createRequireJwt(JWT_SECRET, logger));
        router.use('/api/v1', requireAnyCredential);
        router.use(createRequireChannelExceptMe(channels));
        router.use(createResourceRouter({
            logger,
            repositories: (channelId) => createChannelRepositories(handle.db, channelId),
            channels,
            apiKeys,
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            dashboard: (channelId) => new DashboardRepository(handle.db, channelId),
            songs: (channelId) => new SongQueueRepository(handle.db, channelId),
            // No session in this suite; the reload has nothing to tell.
            reloadChannelContent: async () => undefined,
            applyChannelEnabled: (channelId, enabled) => applyChannelEnabled(ports, channelId, enabled)
        }));

        app = createApp({ logger, version: 'test', routers: [router] });
    }, 60_000);

    afterAll(async () => {
        await manager?.stopAll();
        await handle?.close();
    });

    const asAlpha = (): string => `Bearer ${alpha.token}`;
    const asBeta = (): string => `Bearer ${beta.token}`;

    beforeEach(async () => {
        // Both channels start enabled, active, and running.
        for (const c of [alpha, beta]) {
            await handle.sql`
                update channels set enabled = true, status = 'active' where id = ${c.id}`;
            await manager.remove(c.id);
            await manager.add(buildSession({ id: c.id, twitchBroadcasterId: c.broadcasterId }));
        }
    });

    describe('the flip drives the session', () => {
        it('stops the session when the owner switches the bot off', async () => {
            expect(manager.get(alpha.id)).toBeDefined();

            const res = await request(app)
                .patch('/api/v1/me/channel')
                .set('authorization', asAlpha())
                .send({ enabled: false })
                .expect(200);

            expect(res.body.data.enabled).toBe(false);

            // The session is genuinely gone, not merely marked.
            expect(manager.get(alpha.id)).toBeUndefined();
            // And the transport no longer carries the subscription, so events
            // for a switched-off channel are not merely dropped downstream —
            // they are never requested.
            expect(transport.subscribed.has(alpha.broadcasterId)).toBe(false);
        });

        it('starts the session again when the owner switches it back on', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);
            expect(manager.get(alpha.id)).toBeUndefined();

            const res = await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: true }).expect(200);

            expect(res.body.data.enabled).toBe(true);
            expect(manager.get(alpha.id)).toBeDefined();
            expect(manager.get(alpha.id)?.getState()).toBe('running');
            expect(transport.subscribed.has(alpha.broadcasterId)).toBe(true);
        });

        it('is idempotent — switching off twice is not an error', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            expect(manager.get(alpha.id)).toBeUndefined();
        });
    });

    describe('enabled is not status', () => {
        it('leaves status untouched when the switch moves', async () => {
            const res = await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            // The response says both, and they disagree — which is the point.
            expect(res.body.data).toEqual({ enabled: false, status: 'active' });

            const [row] = await handle.sql`select status, enabled from channels where id = ${alpha.id}`;
            expect(row).toMatchObject({ status: 'active', enabled: false });
        });

        it('reports a revoked channel as revoked even while the owner has it switched on', async () => {
            // Twitch cut this channel off; the owner never touched the switch.
            await channels.setStatus(alpha.id, 'needs_reauth');

            const res = await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: true }).expect(200);

            // A conflated implementation reports 'active' here (or reports the
            // bot as merely off), and the broadcaster is told the wrong story
            // about why their bot is silent.
            expect(res.body.data).toEqual({ enabled: true, status: 'needs_reauth' });
        });

        it('does not start a session for a revoked channel the owner switches on', async () => {
            await manager.remove(alpha.id);
            await channels.setStatus(alpha.id, 'needs_reauth');

            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: true }).expect(200);

            // Wanting the bot on does not grant consent Twitch withdrew.
            expect(manager.get(alpha.id)).toBeUndefined();
        });

        it('surfaces both fields on /me', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            const me = await request(app).get('/api/v1/me').set('authorization', asAlpha()).expect(200);
            expect(me.body.data.channel).toMatchObject({ status: 'active', enabled: false });
        });

        it('keeps a switched-off choice across a Twitch reconnect', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            // Re-authorizing with Twitch says nothing about wanting the bot on.
            await channels.upsert({
                twitchBroadcasterId: alpha.broadcasterId, twitchLogin: 'swalpha', displayName: null
            });

            const found = await channels.findById(alpha.id);
            expect(found).toMatchObject({ status: 'active', enabled: false });
        });
    });

    describe('boot honours the switch', () => {
        it('omits a switched-off channel from the channels the server starts', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            const active = await channels.listActive();
            expect(active.map((c) => c.id)).not.toContain(alpha.id);
            // Beta is untouched and still starts.
            expect(active.map((c) => c.id)).toContain(beta.id);
        });
    });

    describe('tenancy', () => {
        it('switching one channel off leaves the other session running', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: false }).expect(200);

            expect(manager.get(alpha.id)).toBeUndefined();
            // Beta was never named in the request and cannot be.
            expect(manager.get(beta.id)).toBeDefined();
            expect(transport.subscribed.has(beta.broadcasterId)).toBe(true);

            const [betaRow] = await handle.sql`select enabled from channels where id = ${beta.id}`;
            expect(betaRow).toMatchObject({ enabled: true });
        });

        it('each token flips only its own channel', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asBeta())
                .send({ enabled: false }).expect(200);

            const [alphaRow] = await handle.sql`select enabled from channels where id = ${alpha.id}`;
            const [betaRow] = await handle.sql`select enabled from channels where id = ${beta.id}`;
            expect(alphaRow).toMatchObject({ enabled: true });
            expect(betaRow).toMatchObject({ enabled: false });
        });
    });

    describe('credentials', () => {
        it('refuses an API key', async () => {
            const key = await apiKeys.create(alpha.id, 'stream deck');

            const res = await request(app)
                .patch('/api/v1/me/channel')
                .set('x-api-key', key.key)
                .send({ enabled: false })
                .expect(403);

            expect(res.body.error.code).toBe('forbidden');
            // And nothing happened: a refused request must not have side effects.
            expect(manager.get(alpha.id)).toBeDefined();
            const [row] = await handle.sql`select enabled from channels where id = ${alpha.id}`;
            expect(row).toMatchObject({ enabled: true });
        });

        it('refuses an unauthenticated caller', async () => {
            await request(app).patch('/api/v1/me/channel').send({ enabled: false }).expect(401);
        });

        it('refuses a body that is not a boolean', async () => {
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: 'off' }).expect(400);
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({}).expect(400);

            expect(manager.get(alpha.id)).toBeDefined();
        });
    });
});
