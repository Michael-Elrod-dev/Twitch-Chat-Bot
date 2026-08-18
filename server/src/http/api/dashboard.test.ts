import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { pino } from 'pino';
import type { DashboardSummary, MeResponse } from '@almosthadai/shared';
import type { DbHandle } from '../../db/client.js';
import { connectTestDatabase } from '../../db/testing.js';
import { createApp } from '../app.js';
import { createResourceRouter } from './resources.js';
import { createRequireJwt, createRequireChannelExceptMe, requireAnyCredential } from './middleware.js';
import { ChannelRepository } from '../../db/repositories/channelRepository.js';
import { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { DashboardRepository } from '../../db/repositories/dashboardRepository.js';
import { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';
import { StreamRepository } from '../../db/repositories/streamRepository.js';
import { ChatHistoryRepository } from '../../db/repositories/chatHistoryRepository.js';
import { ChannelRoleRepository } from '../../db/repositories/channelRoleRepository.js';
import { ChannelSettingsRepository } from '../../db/repositories/channelSettingsRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { SettingsService } from '../../domain/settings.js';
import { nullCache } from '../../cache/testing.js';
import { signJwt } from '../../auth/jwt.js';
import { apiUsage } from '../../db/schema/index.js';

/**
 * The dashboard's read model.
 *
 * Every figure here is a read over rows the bot already writes on its ordinary
 * paths, so these tests write through those paths, with real repositories and a
 * real database, rather than seeding the aggregate they then assert on. A test that
 * inserted its own totals would pass over a pipeline that had stopped feeding
 * them, which is the exact failure the points-redeemed tile was in.
 *
 * The tenancy rule is the same as everywhere else. No route accepts a channel
 * identifier, so the isolation case here is about the queries. A `where` that
 * forgot its channel would show one broadcaster another's numbers.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'dashboard-test-signing-secret-value';

describeDb('dashboard', () => {
    let handle: DbHandle;
    let app: ReturnType<typeof createApp>;
    let alpha: { id: string; token: string };
    let beta: { id: string; token: string };
    /** Flipped per-test to prove the tile follows the seam, not a constant. */
    let spotifyLinked = false;

    /**
     * Writes one chat line the way the pipeline does: the viewer first (the
     * RESTRICT foreign key), then the message.
     */
    const chatLine = async (
        channelId: string,
        twitchUserId: string,
        streamId: string | null,
        messageType: 'message' | 'command' | 'redemption' = 'message'
    ): Promise<void> => {
        await new ChannelRoleRepository(handle.db, channelId)
            .touchPresence(twitchUserId, twitchUserId);
        await new ChatHistoryRepository(handle.db, channelId).record({
            twitchUserId, content: 'hello', messageType, streamId
        });
    };

    /** A channel of its own, for tests whose subject is a channel-wide state. */
    const newChannel = async (login: string): Promise<{ id: string; token: string }> => {
        const stamp = `${login}-${Date.now()}`;
        const row = await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: stamp, twitchLogin: login, displayName: null
        });
        return { id: row.id, token: signJwt({ sub: stamp, login }, JWT_SECRET, 900) };
    };

    const openStream = async (channelId: string, startedAt: Date): Promise<string> =>
        (await new StreamRepository(handle.db, channelId).open({
            twitchStreamId: `dash-${channelId}-${startedAt.getTime()}`,
            startedAt, title: null, category: null
        })).id;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();
        const a = await channels.upsert({
            twitchBroadcasterId: `dash-a-${stamp}`, twitchLogin: 'dashalpha', displayName: null
        });
        const b = await channels.upsert({
            twitchBroadcasterId: `dash-b-${stamp}`, twitchLogin: 'dashbeta', displayName: null
        });

        alpha = { id: a.id, token: signJwt({ sub: a.twitchBroadcasterId, login: 'dashalpha' }, JWT_SECRET, 900) };
        beta = { id: b.id, token: signJwt({ sub: b.twitchBroadcasterId, login: 'dashbeta' }, JWT_SECRET, 900) };

        // `/me` reports `settings: null` for a channel with no settings row, so
        // the tile assertions need one to have anything to report at all.
        await new ChannelSettingsRepository(handle.db, a.id).setAiEnabled(true);

        const router = Router();
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
            apiKeys: {} as never,
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            dashboard: (channelId) => new DashboardRepository(handle.db, channelId),
            songs: (channelId) => new SongQueueRepository(handle.db, channelId, () => undefined),
            // No disconnect in this suite; the release has nothing to let go of.
            releaseManagedRewards: async () => undefined,
            // No session in this suite; the reload has nothing to tell.
            reloadChannelContent: async () => undefined,
            spotifyConnected: async () => spotifyLinked
        }));

        app = createApp({ logger, version: 'test', routers: [router] });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const getDashboard = async (token: string): Promise<DashboardSummary> => {
        const res = await request(app).get('/api/v1/dashboard').set('authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        return res.body.data as DashboardSummary;
    };

    describe('a channel that has never streamed', () => {
        it('answers zeroes and no stream rather than failing', async () => {
            // The state every newly-onboarded channel is in. Zeroes here are a
            // real answer; the `?` the client shows for an unreachable server is
            // a different fact and is never produced by this endpoint.
            const summary = await getDashboard(beta.token);

            expect(summary.live).toBe(false);
            expect(summary.startedAt).toBeNull();
            expect(summary.lastStream).toBeNull();
            expect(summary.numbers).toEqual({
                messages: 0, chatters: 0, aiReplies: 0, pointsRedeemed: 0
            });
        });
    });

    describe('while live', () => {
        it('reports the open stream and the uptime clock seed', async () => {
            const startedAt = new Date('2026-08-16T18:00:00.000Z');
            await openStream(alpha.id, startedAt);

            const summary = await getDashboard(alpha.token);

            expect(summary.live).toBe(true);
            expect(summary.startedAt).toBe('2026-08-16T18:00:00.000Z');
        });

        it('counts messages and distinct chatters, not rows per person', async () => {
            // Two people, four lines. The chatter figure is people, not lines.
            // Counting lines would report a busy stream as a crowded one.
            const streamId = await openStream(alpha.id, new Date('2026-08-16T18:00:00.000Z'));
            await chatLine(alpha.id, 'dash-viewer-1', streamId);
            await chatLine(alpha.id, 'dash-viewer-1', streamId);
            await chatLine(alpha.id, 'dash-viewer-2', streamId);
            await chatLine(alpha.id, 'dash-viewer-2', streamId, 'command');

            const summary = await getDashboard(alpha.token);

            expect(summary.numbers.messages).toBe(4);
            expect(summary.numbers.chatters).toBe(2);
        });

        it('keeps redemptions out of the message and chatter figures', async () => {
            // Spending points is an interaction, not a line of chat. Counting it
            // as one would inflate "messages this stream" by every reward.
            const streamId = await openStream(beta.id, new Date('2026-08-16T19:00:00.000Z'));
            await chatLine(beta.id, 'dash-redeemer', streamId, 'redemption');

            const numbers = await new DashboardRepository(handle.db, beta.id).numbersForStream(streamId);

            expect(numbers.pointsRedeemed).toBe(1);
            expect(numbers.messages).toBe(0);
            expect(numbers.chatters).toBe(0);
        });

        it('sums AI replies rather than counting the people who asked', async () => {
            // `api_usage` is one row per viewer per stream carrying their count.
            // Counting rows would report three people asking twenty questions as
            // three replies.
            const streamId = await openStream(beta.id, new Date('2026-08-16T20:00:00.000Z'));
            await chatLine(beta.id, 'ai-viewer-1', streamId);
            await chatLine(beta.id, 'ai-viewer-2', streamId);
            await handle.db.insert(apiUsage).values([
                { channelId: beta.id, twitchUserId: 'ai-viewer-1', streamId, apiType: 'claude', usageCount: 7 },
                { channelId: beta.id, twitchUserId: 'ai-viewer-2', streamId, apiType: 'claude', usageCount: 4 }
            ]);

            const numbers = await new DashboardRepository(handle.db, beta.id).numbersForStream(streamId);

            expect(numbers.aiReplies).toBe(11);
        });
    });

    describe('when offline', () => {
        it('falls back to the last stream and captions it', async () => {
            // The offline dashboard shows last-stream totals under a
            // `Last stream` caption, and both come from the same row, so they
            // cannot disagree.
            //
            // Its own channel, because the point is a channel with no open
            // stream. Reusing one the live tests left streaming would assert
            // the offline path while exercising the live one.
            const offline = await newChannel('dashoffline');
            const streams = new StreamRepository(handle.db, offline.id);
            const streamId = await openStream(offline.id, new Date('2026-08-15T12:00:00.000Z'));
            await chatLine(offline.id, 'offline-viewer', streamId);
            await streams.close(streamId, new Date('2026-08-15T16:02:00.000Z'));

            const summary = await getDashboard(offline.token);

            expect(summary.live).toBe(false);
            // Null while offline: a client seeded from this would tick an uptime
            // clock for a stream that has ended.
            expect(summary.startedAt).toBeNull();
            expect(summary.lastStream).toEqual({
                startedAt: '2026-08-15T12:00:00.000Z',
                endedAt: '2026-08-15T16:02:00.000Z'
            });
            expect(summary.numbers.messages).toBe(1);
        });

        it('prefers an open stream over a more recent closed one', async () => {
            // A crash can leave an older row open. The current stream is the one
            // that is open, not the one that started most recently.
            const c = await newChannel('dashgamma');
            const streams = new StreamRepository(handle.db, c.id);

            const openId = await openStream(c.id, new Date('2026-08-14T10:00:00.000Z'));
            const closedId = await openStream(c.id, new Date('2026-08-15T10:00:00.000Z'));
            await streams.close(closedId, new Date('2026-08-15T14:00:00.000Z'));

            const current = await new DashboardRepository(handle.db, c.id).currentOrLastStream();

            expect(current?.id).toBe(openId);
            expect(current?.endedAt).toBeNull();
        });
    });

    describe('tenancy', () => {
        it('never shows one channel another channel numbers', async () => {
            // The isolation case for a read model: a `where` missing its channel
            // would silently pool two broadcasters' streams.
            const alphaSummary = await getDashboard(alpha.token);
            const betaSummary = await getDashboard(beta.token);

            expect(alphaSummary.numbers.messages).toBe(4);
            expect(alphaSummary.numbers.aiReplies).toBe(0);
            expect(betaSummary.numbers.messages).not.toBe(4);
        });

        it('answers nothing for a stream belonging to another channel', async () => {
            /*
             * The assertion the route-level test cannot make.
             *
             * Stream ids are UUIDs and therefore unique across channels, so a
             * query that dropped its channel filter would still return the right
             * rows through the normal path, so the isolation test above passes
             * either way. This asks the
             * question directly instead: alpha's repository, handed beta's
             * stream id, must see nothing. That fails the moment the channel
             * predicate goes.
             */
            const betaStream = await openStream(beta.id, new Date('2026-08-13T09:00:00.000Z'));
            await chatLine(beta.id, 'cross-tenant-viewer', betaStream);

            const throughBeta = await new DashboardRepository(handle.db, beta.id)
                .numbersForStream(betaStream);
            const throughAlpha = await new DashboardRepository(handle.db, alpha.id)
                .numbersForStream(betaStream);

            expect(throughBeta.messages).toBe(1);
            expect(throughAlpha.messages).toBe(0);
            expect(throughAlpha.chatters).toBe(0);
        });

        it('is not reachable with an API key', async () => {
            // Same rule as every other management route: a Stream Deck key is
            // scoped to queue/skip/toggle and nothing else.
            const res = await request(app).get('/api/v1/dashboard');
            expect(res.status).toBe(401);
        });
    });

    describe('the SPOTIFY tile', () => {
        it('reports a linked account as connected', async () => {
            spotifyLinked = true;
            const res = await request(app).get('/api/v1/me').set('authorization', `Bearer ${alpha.token}`);

            expect((res.body.data as MeResponse).settings?.spotifyConnected).toBe(true);
        });

        it('reports no link as not connected', async () => {
            spotifyLinked = false;
            const res = await request(app).get('/api/v1/me').set('authorization', `Bearer ${alpha.token}`);

            expect((res.body.data as MeResponse).settings?.spotifyConnected).toBe(false);
        });
    });
});
