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
import { SettingsService } from '../../domain/settings.js';
import { nullCache } from '../../cache/testing.js';
import { signJwt } from '../../auth/jwt.js';
import { SessionManager } from '../../session/sessionManager.js';
import { FakeTransport } from '../../transport/fakeTransport.js';
import { ChannelSession } from '../../session/channelSession.js';
import { applyChannelEnabled, type ChannelSwitchPorts } from '../../session/channelSwitch.js';
import { ChannelRewardRepository } from '../../db/repositories/channelRewardRepository.js';
import { releaseManagedRewards } from '../../services/rewardRelease.js';

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
    /** Every reward the release switched OFF at Twitch, in order. Never deleted. */
    const disabledRewards: { channelId: string; rewardId: string }[] = [];
    /** Flipped by the test that checks a Twitch refusal cannot block a disconnect. */
    let rewardDisableFails = false;

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
            settings: (channelId) => new SettingsService({
                channelId,
                repository: createChannelRepositories(handle.db, channelId).settings,
                cache: nullCache(),
                logger
            }),
            channels,
            apiKeys,
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            dashboard: (channelId) => new DashboardRepository(handle.db, channelId),
            songs: (channelId) => new SongQueueRepository(handle.db, channelId, () => undefined),
            // No session in this suite; the reload has nothing to tell.
            reloadChannelContent: async () => undefined,
            applyChannelEnabled: (channelId, enabled) => applyChannelEnabled(ports, channelId, enabled),
            rewards: (channelId) => new ChannelRewardRepository(handle.db, channelId),
            /*
             * The real release service over a recording Twitch double.
             *
             * Deliberately not a spy on the seam: "the seam was called" stays
             * green against a release that disables nothing and forgets no rows,
             * which is the shape of vacuous test this project has caught seven
             * times. The repository here is real, so the rows genuinely have to
             * go, and `disabledRewards` records what would have reached Twitch.
             */
            releaseManagedRewards: (channelId) => releaseManagedRewards({
                channelId,
                logger,
                rewards: new ChannelRewardRepository(handle.db, channelId),
                disableReward: async (rewardId) => {
                    disabledRewards.push({ channelId, rewardId });
                    if (rewardDisableFails) throw new Error('Twitch said no');
                }
            }).then(() => undefined)
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
            await handle.sql`delete from channel_rewards where channel_id = ${c.id}`;
            await manager.remove(c.id);
            await manager.add(buildSession({ id: c.id, twitchBroadcasterId: c.broadcasterId }));
        }
        disabledRewards.length = 0;
        rewardDisableFails = false;
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

    /**
     * The danger zone (`5c`).
     *
     * The most consequential thing the app can do, and the only one behind a
     * confirmation. **It is never exercised against the owner's live channel** —
     * this suite is where it is proven, on throwaway channels in a throwaway
     * database, and the live proof deliberately skips it.
     *
     * Everything here asks the same question from a different side: did the bot
     * actually leave, and did anything the streamer wrote leave with it?
     */
    describe('disconnecting the channel', () => {
        /** Binds all three managed rewards, as an onboarded channel has them. */
        const bindRewards = async (channelId: string): Promise<void> => {
            const rewards = new ChannelRewardRepository(handle.db, channelId);
            await rewards.upsert({ kind: 'song_request', rewardId: `${channelId}-sr`, title: 'Song Request' });
            await rewards.upsert({ kind: 'skip_queue', rewardId: `${channelId}-sk`, title: 'Skip song queue' });
            await rewards.upsert({ kind: 'add_quote', rewardId: `${channelId}-aq`, title: 'Add a quote' });
        };

        it('marks the channel disconnected and stops the bot', async () => {
            expect(manager.get(alpha.id)).toBeDefined();

            const res = await request(app)
                .delete('/api/v1/me/channel')
                .set('authorization', asAlpha())
                .expect(200);

            expect(res.body.data.status).toBe('disconnected');
            // Genuinely gone, not merely recorded — the same standard the switch
            // is held to one describe block up.
            expect(manager.get(alpha.id)).toBeUndefined();
            expect(transport.subscribed.has(alpha.broadcasterId)).toBe(false);
        });

        it('switches all three managed rewards off and forgets their bindings', async () => {
            await bindRewards(alpha.id);

            await request(app).delete('/api/v1/me/channel').set('authorization', asAlpha()).expect(200);

            /*
             * A reward left ENABLED on a disconnected channel stays redeemable
             * against a bot that has left: the viewer spends points and nothing
             * happens. That is the failure this asserts against.
             *
             * Disabled and not deleted, deliberately — two of the owner own
             * rewards predate this application entirely, and their title, cost,
             * prompt and redemption history are theirs to keep for a channel they
             * may reconnect.
             */
            expect(disabledRewards.map((r) => r.rewardId).sort()).toEqual([
                `${alpha.id}-aq`, `${alpha.id}-sk`, `${alpha.id}-sr`
            ]);
            expect(await new ChannelRewardRepository(handle.db, alpha.id).listAll()).toEqual([]);
        });

        it('completes even when Twitch refuses the reward disables', async () => {
            await bindRewards(alpha.id);
            rewardDisableFails = true;

            const res = await request(app)
                .delete('/api/v1/me/channel')
                .set('authorization', asAlpha())
                .expect(200);

            /*
             * A streamer who has asked the bot to leave must not be told "no"
             * because Twitch returned an error. The two wrong states are not
             * symmetric: a channel recorded as disconnected whose rewards survive
             * is untidy, and a channel recorded as connected whose bot has gone is
             * a lie the owner will act on.
             */
            expect(res.body.data.status).toBe('disconnected');
            expect(manager.get(alpha.id)).toBeUndefined();
            // And the bindings go regardless, so a disconnected channel is not
            // left believing it still manages three rewards.
            expect(await new ChannelRewardRepository(handle.db, alpha.id).listAll()).toEqual([]);
        });

        it('keeps every command, emote and quote the streamer wrote', async () => {
            // The promise the danger card makes in words, asserted in rows. It is
            // also the reason coming back is worth doing.
            await request(app).post('/api/v1/commands').set('authorization', asAlpha())
                .send({ name: '!keepme', responseText: 'still here', userLevel: 'everyone' }).expect(201);
            await request(app).post('/api/v1/emotes').set('authorization', asAlpha())
                .send({ triggerText: 'keepme', responseText: 'still here' }).expect(201);
            await request(app).post('/api/v1/quotes').set('authorization', asAlpha())
                .send({ quoteText: 'still here' }).expect(201);

            await request(app).delete('/api/v1/me/channel').set('authorization', asAlpha()).expect(200);

            const repositories = createChannelRepositories(handle.db, alpha.id);
            expect((await repositories.commands.listAll()).some((c) => c.name === '!keepme')).toBe(true);
            expect((await repositories.emotes.listAll()).some((e) => e.triggerText === 'keepme')).toBe(true);
            expect(await repositories.quotes.count()).toBeGreaterThan(0);
        });

        it('leaves the owner pause preference alone rather than folding it in', async () => {
            // `enabled` is what the owner chose about pausing and means nothing
            // right now; `status` is what disconnecting did. Writing `enabled`
            // here would offer a one-click undo for something one click cannot
            // undo — see the contract's note on the two fields.
            const res = await request(app).delete('/api/v1/me/channel')
                .set('authorization', asAlpha()).expect(200);

            expect(res.body.data).toEqual({ enabled: true, status: 'disconnected' });
            const [row] = await handle.sql`select status, enabled from channels where id = ${alpha.id}`;
            expect(row).toMatchObject({ status: 'disconnected', enabled: true });
        });

        it('does not restart the bot when the header switch is flipped afterwards', async () => {
            await request(app).delete('/api/v1/me/channel').set('authorization', asAlpha()).expect(200);

            // Wanting the bot on does not undo a teardown, exactly as it does not
            // grant consent Twitch withdrew. `listActive` requires both.
            await request(app).patch('/api/v1/me/channel').set('authorization', asAlpha())
                .send({ enabled: true }).expect(200);

            expect(manager.get(alpha.id)).toBeUndefined();
        });

        it('leaves the other channel connected and running', async () => {
            await bindRewards(alpha.id);
            await bindRewards(beta.id);

            await request(app).delete('/api/v1/me/channel').set('authorization', asAlpha()).expect(200);

            expect(manager.get(beta.id)).toBeDefined();
            expect(transport.subscribed.has(beta.broadcasterId)).toBe(true);
            // Beta was never named in the request and cannot be — including in
            // the reward cleanup, which is the part that reaches out to Twitch.
            expect(disabledRewards.every((r) => r.channelId === alpha.id)).toBe(true);
            expect(await new ChannelRewardRepository(handle.db, beta.id).listAll()).toHaveLength(3);

            const [betaRow] = await handle.sql`select status from channels where id = ${beta.id}`;
            expect(betaRow).toMatchObject({ status: 'active' });
        });

        it('refuses an API key', async () => {
            const key = await apiKeys.create(alpha.id, 'stream deck');

            const res = await request(app).delete('/api/v1/me/channel')
                .set('x-api-key', key.key).expect(403);

            expect(res.body.error.code).toBe('forbidden');
            // A key taped inside a Stream Deck profile must not be able to end
            // the channel, and a refused request must have no side effects.
            expect(res.body.error.code).toBe('forbidden');
            expect(manager.get(alpha.id)).toBeDefined();
            const [row] = await handle.sql`select status from channels where id = ${alpha.id}`;
            expect(row).toMatchObject({ status: 'active' });
        });

        it('refuses an unauthenticated caller', async () => {
            await request(app).delete('/api/v1/me/channel').expect(401);
            expect(manager.get(alpha.id)).toBeDefined();
        });
    });
});
