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
import { CommandRepository } from '../../db/repositories/commandRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { CommandManager } from '../../domain/commandManager.js';
import { EmoteManager } from '../../domain/emoteManager.js';
import { ChatPipeline } from '../../session/chatPipeline.js';
import { ChannelSession } from '../../session/channelSession.js';
import { RecordingChatSink } from '../../services/chatSink.js';
import { StubAiService } from '../../services/aiService.js';
import { NoopAnalyticsSink } from '../../services/analytics.js';
import { SettingsService } from '../../domain/settings.js';
import type { CacheManager } from '../../cache/cacheManager.js';
import { signJwt } from '../../auth/jwt.js';

/**
 * THE BUG THIS PACKAGE SHIPPED AND THE OWNER FOUND IN A MINUTE.
 *
 * A command created in the app saved correctly and never fired in chat.
 *
 * Nothing was wrong with either half. The route wrote the row; the pipeline read
 * its managers. The failure lived in the gap: `CommandManager` keeps an
 * in-memory map and a populated cache hash, and its lookup deliberately treats
 * "hash exists, field absent" as an authoritative miss so that an ordinary chat
 * message never costs a database round trip. That optimization is correct and
 * load-bearing — and it makes a row inserted behind the manager's back invisible
 * **permanently**, not briefly: once the hash expires, the fallback consults the
 * in-memory map, which `loaded` already marks as good.
 *
 * So these tests deliberately span both layers. A route test would have passed
 * (the row is written) and a pipeline test would have passed (it answers what it
 * was loaded with). Only asking "does the bot answer a command the API just
 * created" can fail, which is exactly why it is the test that exists.
 *
 * The cache here is the null one, so the reproduction does NOT depend on Redis:
 * the staleness is in the in-memory map, and Redis only makes it faster to hit.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'content-reload-test-signing-secret';
const BOT_ID = 'bot-content-reload';

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

describeDb('content reaches the running bot', () => {
    let handle: DbHandle;
    let app: ReturnType<typeof createApp>;
    let session: ChannelSession;
    let sink: RecordingChatSink;
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
        const stamp = `reload-${Date.now()}`;
        const row = await channels.upsert({
            twitchBroadcasterId: stamp, twitchLogin: 'reloadchannel', displayName: null
        });
        channel = {
            id: row.id,
            broadcasterId: row.twitchBroadcasterId,
            token: signJwt({ sub: row.twitchBroadcasterId, login: 'reloadchannel' }, JWT_SECRET, 900)
        };

        sink = new RecordingChatSink();
        const repositories = createChannelRepositories(handle.db, channel.id);
        const cache = nullCache();

        const commands = new CommandManager({
            channelId: channel.id, repository: repositories.commands, cache, logger
        });
        const emotes = new EmoteManager({
            channelId: channel.id, repository: repositories.emotes, cache
        });

        const pipeline = new ChatPipeline({
            channelId: channel.id,
            botTwitchUserId: BOT_ID,
            aiTriggers: ['bot'],
            commands,
            emotes,
            settings: new SettingsService({
                channelId: channel.id, repository: repositories.settings, cache, logger
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
        // Loads the (empty) content, exactly as a real session does at start —
        // which is the state that makes a later insert invisible.
        await session.start();

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
            // The seam under test, wired as the composition root wires it.
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

    it('answers a command created through the API, without a restart', async () => {
        // The owner's exact report: saved in the app, silent in chat.
        await auth(request(app).post('/api/v1/commands').send({
            name: '!wp9b', responseText: 'it works', userLevel: 'everyone'
        })).expect(201);

        await session.handleEvent(chat('!wp9b'));

        expect(sink.sent.map((s) => s.text)).toEqual(['it works']);
    });

    it('answers with the NEW text after an edit', async () => {
        await auth(request(app).post('/api/v1/commands').send({
            name: '!edited', responseText: 'before', userLevel: 'everyone'
        })).expect(201);

        await auth(request(app).patch('/api/v1/commands/%21edited').send({ responseText: 'after' }))
            .expect(200);

        await session.handleEvent(chat('!edited'));

        // Not 'before': a reload that only ran on create would leave the old
        // text answering forever.
        expect(sink.sent.map((s) => s.text)).toEqual(['after']);
    });

    it('goes silent after a delete', async () => {
        await auth(request(app).post('/api/v1/commands').send({
            name: '!temporary', responseText: 'here', userLevel: 'everyone'
        })).expect(201);
        await auth(request(app).delete('/api/v1/commands/%21temporary')).expect(204);

        await session.handleEvent(chat('!temporary'));

        // The harder half of the loop: a cached command that has been deleted
        // keeps answering, which is worse than one that never started.
        expect(sink.sent).toHaveLength(0);
    });

    it('replies to an emote added through the composer', async () => {
        await auth(request(app).post('/api/v1/emotes').send({
            triggerText: 'kekw', responseText: 'KEKW right back'
        })).expect(201);

        await session.handleEvent(chat('kekw'));

        expect(sink.sent.map((s) => s.text)).toEqual(['KEKW right back']);
    });

    it('stops replying to a deleted emote', async () => {
        await auth(request(app).post('/api/v1/emotes').send({
            triggerText: 'sadge', responseText: 'Sadge'
        })).expect(201);
        await auth(request(app).delete('/api/v1/emotes/sadge')).expect(204);

        await session.handleEvent(chat('sadge'));

        expect(sink.sent).toHaveLength(0);
    });

    it('keeps the exact-match rule after a reload', async () => {
        // The reload must not quietly change matching semantics.
        await auth(request(app).post('/api/v1/emotes').send({
            triggerText: 'gg', responseText: 'good game'
        })).expect(201);

        await session.handleEvent(chat('that was a gg for sure'));

        expect(sink.sent).toHaveLength(0);
    });

    it('does not fail the write when there is no session to tell', async () => {
        /*
         * A channel whose bot is switched off has no session. The owner must
         * still be able to edit their commands — the next start reads from the
         * database anyway — so an absent session is a no-op, not an error.
         */
        const channels = new ChannelRepository(handle.db);
        const stamp = `nosession-${Date.now()}`;
        const other = await channels.upsert({
            twitchBroadcasterId: stamp, twitchLogin: 'nosession', displayName: null
        });
        const token = signJwt({ sub: stamp, login: 'nosession' }, JWT_SECRET, 900);

        await request(app).post('/api/v1/commands')
            .set('authorization', `Bearer ${token}`)
            .send({ name: '!offline', responseText: 'saved anyway', userLevel: 'everyone' })
            .expect(201);

        const stored = await new CommandRepository(handle.db, other.id).listAll();
        expect(stored.map((c) => c.name)).toContain('!offline');
    });
});
