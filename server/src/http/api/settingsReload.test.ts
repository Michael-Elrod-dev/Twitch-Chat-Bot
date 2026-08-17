import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { pino } from 'pino';
import type { TransportEvent } from '@almosthadai/shared';
import type { DbHandle } from '../../db/client.js';
import { connectTestDatabase } from '../../db/testing.js';
import { createApp } from '../app.js';
import { createResourceRouter } from './resources.js';
import { createRequireJwt, createRequireChannelExceptMe, requireAnyCredential } from './middleware.js';
import { ChannelRepository } from '../../db/repositories/channelRepository.js';
import { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { DashboardRepository } from '../../db/repositories/dashboardRepository.js';
import { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { CommandManager } from '../../domain/commandManager.js';
import { EmoteManager } from '../../domain/emoteManager.js';
import { ChatPipeline } from '../../session/chatPipeline.js';
import { ChannelSession } from '../../session/channelSession.js';
import { RecordingChatSink } from '../../services/chatSink.js';
import { StubAiService } from '../../services/aiService.js';
import { NoopAnalyticsSink } from '../../services/analytics.js';
import { SettingsService } from '../../domain/settings.js';
import { signJwt } from '../../auth/jwt.js';
import { MapCache, asCacheManager } from '../../cache/testing.js';

/**
 * TASK 0 — the same class as the content-reload bug, hunted rather than reported.
 *
 * `PATCH /me/settings` writes through `ChannelSettingsRepository`. The running
 * session reads through `SettingsService`, which caches the whole settings row
 * in Redis for 60 seconds. Nothing connects the two, so a setting the owner
 * changes in the app does not reach the bot until that TTL expires.
 *
 * It differs from the commands hole in duration and only in duration: that one
 * was permanent (an in-memory map behind a populated hash), this one heals
 * itself within a minute. It is still the owner flipping "Let the bot answer"
 * off, watching the bot answer anyway, and having no way to tell whether the
 * app saved anything — which is the bug they reported last package, wearing a
 * shorter clock.
 *
 * **The cache here is a real one.** A null cache cannot reproduce this at all
 * (every read would fall through to the database and pass), so these tests use
 * a Map-backed `CacheManager` that stores and returns what it was given, the
 * way Redis does. If that cache were a stub that always missed, the tests would
 * be green against the broken code — a harness that cannot fail is not
 * evidence, and this file is the place that rule bites hardest.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'settings-reload-test-signing-secret';
const BOT_ID = 'bot-settings-reload';

describeDb('settings reach the running bot', () => {
    let handle: DbHandle;
    let app: ReturnType<typeof createApp>;
    let session: ChannelSession;
    let sink: RecordingChatSink;
    let cache: MapCache;
    let channel: { id: string; broadcasterId: string; token: string };

    const chat = (text: string): TransportEvent => ({
        kind: 'chat_message',
        messageId: `m-${Math.random()}`,
        broadcasterTwitchId: channel.broadcasterId,
        chatter: {
            twitchUserId: 'viewer-1', login: 'viewer', displayName: 'Viewer',
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        },
        text
    });

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const stamp = `settings-${Date.now()}`;
        const row = await channels.upsert({
            twitchBroadcasterId: stamp, twitchLogin: 'settingschannel', displayName: null
        });
        channel = {
            id: row.id,
            broadcasterId: row.twitchBroadcasterId,
            token: signJwt({ sub: row.twitchBroadcasterId, login: 'settingschannel' }, JWT_SECRET, 900)
        };

        sink = new RecordingChatSink();
        cache = new MapCache();
        const repositories = createChannelRepositories(handle.db, channel.id);

        const commands = new CommandManager({
            channelId: channel.id, repository: repositories.commands, cache: asCacheManager(cache), logger
        });
        const emotes = new EmoteManager({
            channelId: channel.id, repository: repositories.emotes, cache: asCacheManager(cache)
        });

        const pipeline = new ChatPipeline({
            channelId: channel.id,
            botTwitchUserId: BOT_ID,
            aiTriggers: ['botname'],
            commands,
            emotes,
            // The session's own service, with its own cache reads — exactly as
            // `buildChannelSession` constructs it.
            settings: new SettingsService({
                channelId: channel.id, repository: repositories.settings, cache: asCacheManager(cache), logger
            }),
            roles: repositories.roles,
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            logger,
            sendMessage: async (text) => {
                await sink.send({ channelId: channel.id, broadcasterTwitchId: channel.broadcasterId, text });
            }
        });

        session = new ChannelSession({
            channelId: channel.id,
            broadcasterTwitchId: channel.broadcasterId,
            logger, pipeline, commands, emotes
        });
        await session.start();

        const router = Router();
        router.use('/api/v1', createRequireJwt(JWT_SECRET, logger));
        router.use('/api/v1', requireAnyCredential);
        router.use(createRequireChannelExceptMe(channels));
        router.use(createResourceRouter({
            logger,
            repositories: (channelId) => createChannelRepositories(handle.db, channelId),
            // The settings writer, built with the SAME cache the session reads
            // through — which is the whole point: one Redis in production, one
            // Map here, and an invalidation on one side has to be visible on
            // the other.
            settings: (channelId) => new SettingsService({
                channelId,
                repository: createChannelRepositories(handle.db, channelId).settings,
                cache: asCacheManager(cache),
                logger
            }),
            channels,
            apiKeys: {} as never,
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            dashboard: (channelId) => new DashboardRepository(handle.db, channelId),
            songs: (channelId) => new SongQueueRepository(handle.db, channelId),
            reloadChannelContent: async (channelId, kind) => {
                if (channelId === channel.id) await session.reloadContent(kind);
            }
        }));

        app = createApp({ logger, version: 'test', routers: [router] });
    }, 60_000);

    afterAll(async () => {
        await session?.stop();
        await handle?.close();
    });

    beforeEach(() => { sink.sent.length = 0; });

    const auth = (req: request.Test): request.Test =>
        req.set('authorization', `Bearer ${channel.token}`);

    const patch = (body: object): request.Test =>
        auth(request(app).patch('/api/v1/me/settings').send(body));

    it('stops answering when the AI toggle is switched off in the app', async () => {
        // Warm the cache the way a live channel warms it: one AI mention, which
        // populates the settings key with `aiEnabled: true`. Skipping this step
        // would make the test pass against the broken code.
        await session.handleEvent(chat('botname hello'));
        expect(sink.sent).toHaveLength(1);
        sink.sent.length = 0;

        await patch({ aiEnabled: false }).expect(200);

        await session.handleEvent(chat('botname are you there'));

        // The owner's view: they flipped the switch and the bot kept talking.
        expect(sink.sent).toHaveLength(0);
    });

    it('starts answering again when the toggle goes back on', async () => {
        await patch({ aiEnabled: false }).expect(200);
        await session.handleEvent(chat('botname quiet please'));
        expect(sink.sent).toHaveLength(0);

        await patch({ aiEnabled: true }).expect(200);
        await session.handleEvent(chat('botname speak up'));

        // The other direction matters just as much: a stale `false` leaves a bot
        // the owner just re-enabled sitting silent, which reads as broken.
        expect(sink.sent).toHaveLength(1);
    });

    it('refuses song requests as soon as the toggle is turned off', async () => {
        const settings = new SettingsService({
            channelId: channel.id,
            repository: createChannelRepositories(handle.db, channel.id).settings,
            cache: asCacheManager(cache),
            logger
        });

        await patch({ songRequestsEnabled: true }).expect(200);
        expect((await settings.get()).songRequestsEnabled).toBe(true);

        // Not the same route as the app's settings screen — the Stream Deck's
        // one-press toggle — and it writes the same row, so it needs the same
        // invalidation. A second write path is exactly how the first one
        // regresses.
        await auth(request(app).post('/api/v1/songs/toggle').send({ enabled: false })).expect(200);

        expect((await settings.get()).songRequestsEnabled).toBe(false);
    });

    it('serves the value it just wrote, not a cached one', async () => {
        // The response body is what the app renders straight back into the
        // toggle. Reading it from a cache the write did not clear would flip
        // the switch back under the owner's cursor.
        await patch({ aiEnabled: true }).expect(200);
        const response = await patch({ aiEnabled: false }).expect(200);

        expect(response.body.data.aiEnabled).toBe(false);
    });
});
