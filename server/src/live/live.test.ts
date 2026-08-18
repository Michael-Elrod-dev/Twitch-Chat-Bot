import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import request from 'supertest';
import { pino } from 'pino';
import { LIVE_PATH, type LiveEvent } from '@almosthadai/shared';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { createApp } from '../http/app.js';
import { createEventBus } from './eventBus.js';
import { LiveServer } from './liveServer.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { signJwt } from '../auth/jwt.js';
import { EventSubWebhookTransport } from '../transport/eventsub/webhookTransport.js';
import { EVENTSUB_WEBHOOK_PATH } from '../transport/eventsub/webhook.js';
import { chatMessageDelivery } from '../transport/eventsub/synthetic.js';
import { SessionManager } from '../session/sessionManager.js';
import { buildChannelSession, type ChannelDependencies, type ChannelRepositories } from '../bootstrap.js';
import { RecordingChatSink } from '../services/chatSink.js';
import { StubAiService } from '../services/aiService.js';
import { NoopAnalyticsSink } from '../services/analytics.js';
import type { CacheManager } from '../cache/cacheManager.js';

/**
 * THE REALTIME CENTREPIECE: a signed EventSub delivery goes in, and a
 * WebSocket client receives it — **only** if it belongs to that channel.
 *
 * The fan-out is where a multi-tenant realtime feed leaks. A socket is bound to
 * one channel at the upgrade and there is no subscribe message, so these tests
 * attack the remaining surface: another tenant's socket, an unauthenticated
 * upgrade, and a forged token.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'live-test-signing-secret-of-good-length';
const SECRET = 'live-test-eventsub-secret-value';
const BOT_ID = 'bot-live-1';

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const repositoriesWith = (commandName: string, response: string): ChannelRepositories =>
    ({
        commands: {
            listAll: async () => [{ name: commandName, responseText: response, handlerName: null, userLevel: 'everyone' }],
            updateUserLevel: vi.fn()
        },
        emotes: { listAll: async () => [] },
        settings: { get: async () => ({ aiEnabled: true, songRequestsEnabled: true, discordWebhookUrl: null }) },
        roles: { upsertRoles: vi.fn(async () => undefined), get: async () => null },
        quotes: {}
    }) as unknown as ChannelRepositories;

/** Collects everything a socket receives, so assertions can await a specific event. */
class Collector {
    readonly received: LiveEvent[] = [];
    constructor(readonly socket: WebSocket) {
        socket.on('message', (raw) => {
            this.received.push(JSON.parse(String(raw)) as LiveEvent);
        });
    }

    async waitFor(type: string, timeoutMs = 3000): Promise<LiveEvent> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = this.received.find((e) => e.type === type);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timed out waiting for ${type}; got ${this.received.map((e) => e.type).join(', ') || 'nothing'}`);
    }

    of(type: string): LiveEvent[] {
        return this.received.filter((e) => e.type === type);
    }
}

describeDb('realtime feed', () => {
    let handle: DbHandle;
    let httpServer: Server;
    let live: LiveServer;
    let transport: EventSubWebhookTransport;
    let manager: SessionManager;
    let sink: RecordingChatSink;
    let port: number;
    let alpha: { id: string; broadcasterId: string; token: string };
    let beta: { id: string; broadcasterId: string; token: string };
    const sockets: WebSocket[] = [];

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();
        const a = await channels.upsert({
            twitchBroadcasterId: `live-a-${stamp}`, twitchLogin: 'livealpha', displayName: null
        });
        const b = await channels.upsert({
            twitchBroadcasterId: `live-b-${stamp}`, twitchLogin: 'livebeta', displayName: null
        });

        alpha = { id: a.id, broadcasterId: a.twitchBroadcasterId, token: signJwt({ sub: a.twitchBroadcasterId, login: 'livealpha' }, JWT_SECRET, 900) };
        beta = { id: b.id, broadcasterId: b.twitchBroadcasterId, token: signJwt({ sub: b.twitchBroadcasterId, login: 'livebeta' }, JWT_SECRET, 900) };

        const bus = createEventBus();
        sink = new RecordingChatSink();

        transport = new EventSubWebhookTransport({ secret: SECRET, logger, maxSkewMs: 600_000 });
        manager = new SessionManager({ transport, logger });
        await manager.start();

        const deps = (channelId: string, command: string, response: string): ChannelDependencies => ({
            repositories: () => repositoriesWith(command, response),
            cache: nullCache(),
            logger,
            chatSink: sink,
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: BOT_ID, login: 'bot', aiTriggers: ['bot'] },
            bus
        });

        await manager.add(buildChannelSession(
            deps(a.id, '!hello', 'ALPHA hello'),
            { id: a.id, twitchBroadcasterId: a.twitchBroadcasterId, twitchLogin: 'livealpha', status: 'active', enabled: true }
        ));
        await manager.add(buildChannelSession(
            deps(b.id, '!hello', 'BETA hello'),
            { id: b.id, twitchBroadcasterId: b.twitchBroadcasterId, twitchLogin: 'livebeta', status: 'active', enabled: true }
        ));

        const app = createApp({ logger, version: 'test', rawBodyRouters: [transport.router] });
        httpServer = createServer(app);

        live = new LiveServer({
            server: httpServer, bus, channels, logger, jwtSecret: JWT_SECRET, heartbeatMs: 50
        });

        await new Promise<void>((resolve) => httpServer.listen(0, resolve));
        port = (httpServer.address() as { port: number }).port;
    }, 60_000);

    afterAll(async () => {
        for (const s of sockets) s.close();
        await live?.close();
        await manager?.stopAll();
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
        await handle?.close();
    });

    beforeEach(() => {
        sink.sent.length = 0;
    });

    afterEach(() => {
        while (sockets.length) sockets.pop()?.close();
    });

    const connect = async (token: string): Promise<Collector> => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}?access_token=${token}`);
        sockets.push(socket);

        // The collector attaches BEFORE awaiting open. The server greets a
        // client the moment the upgrade completes, and `ws` drops a message
        // that arrives with no listener attached - so subscribing afterwards
        // loses the greeting every time.
        const collector = new Collector(socket);

        await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });

        return collector;
    };

    const deliver = async (broadcasterId: string, text: string, chatterUserId?: string): Promise<void> => {
        const delivery = chatMessageDelivery(SECRET, {
            broadcasterUserId: broadcasterId,
            text,
            ...(chatterUserId === undefined ? {} : { chatterUserId })
        });
        await request(httpServer).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body).expect(204);
        await transport.drain();
    };

    /**
     * The chatter's role, all the way from Twitch's badges to the wire.
     *
     * End-to-end rather than a unit test on the mapping, because the value of
     * this field is that it survives the whole chain: badges are parsed into
     * role flags, the flags decide permissions, and the SAME flags produce the
     * role the feed colors by. A test that called `chatRoleOf` directly would
     * prove the function and not the thing that was missing.
     */
    describe('the chatter role', () => {
        /** Twitch's real badge shape; `info` is empty for these sets. */
        const badge = (setId: string): { set_id: string; id: string; info: string } =>
            ({ set_id: setId, id: '1', info: '' });

        const deliverAs = async (
            broadcasterId: string,
            text: string,
            badges: { set_id: string; id: string; info: string }[],
            chatterUserId = '55555'
        ): Promise<void> => {
            const delivery = chatMessageDelivery(SECRET, {
                broadcasterUserId: broadcasterId, text, badges, chatterUserId
            });
            await request(httpServer).post(EVENTSUB_WEBHOOK_PATH)
                .set(delivery.headers).send(delivery.body).expect(204);
            await transport.drain();
        };

        it('reports a badged moderator as a moderator', async () => {
            // The case 9a could not color at all: without this the feed had
            // only the login to compare, so every mod rendered as a viewer.
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliverAs(alpha.broadcasterId, 'hello all', [badge('moderator')]);

            expect(await client.waitFor('chat.message')).toMatchObject({
                chatter: { role: 'moderator' }
            });
        });

        it('reports an unbadged chatter as a viewer', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliverAs(alpha.broadcasterId, 'hello all', []);

            expect(await client.waitFor('chat.message')).toMatchObject({
                chatter: { role: 'viewer' }
            });
        });

        it('reports a VIP as a vip, not as a moderator', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliverAs(alpha.broadcasterId, 'hello all', [badge('vip')]);

            expect(await client.waitFor('chat.message')).toMatchObject({
                chatter: { role: 'vip' }
            });
        });

        it('reports the broadcaster from their id, badge or no badge', async () => {
            /*
             * A broadcaster's own messages do not reliably carry the badge, so
             * the normalizer derives it from the id. This asserts the role
             * follows that derivation rather than the badge list — otherwise
             * the owner's own lines would render as ordinary viewers in their
             * own dashboard.
             */
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliverAs(alpha.broadcasterId, 'hello all', [], alpha.broadcasterId);

            expect(await client.waitFor('chat.message')).toMatchObject({
                chatter: { role: 'broadcaster' }
            });
        });

        it('outranks: a moderator who is also a VIP reads as a moderator', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliverAs(alpha.broadcasterId, 'hello all',
                [badge('vip'), badge('moderator')]);

            expect(await client.waitFor('chat.message')).toMatchObject({
                chatter: { role: 'moderator' }
            });
        });
    });

    describe('the end-to-end path', () => {
        it('delivers a real EventSub chat message to a subscribed client', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliver(alpha.broadcasterId, '!hello');

            const event = await client.waitFor('chat.message');
            expect(event).toMatchObject({
                type: 'chat.message',
                channelId: alpha.id,
                text: '!hello',
                outcome: 'command'
            });

            // And the bot answered, so this is the full path, not just a tap.
            expect(sink.textsFor(alpha.id)).toEqual(['ALPHA hello']);
        });

        it('reports the pipeline decision, so a UI can explain the silence', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliver(alpha.broadcasterId, 'just chatting');

            expect(await client.waitFor('chat.message')).toMatchObject({ outcome: 'none' });
        });

        it('marks the bot own reply so the UI can wash that row', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            // The bot's replies come back to us as ordinary chat deliveries.
            await deliver(alpha.broadcasterId, 'ALPHA hello', BOT_ID);

            expect(await client.waitFor('chat.message')).toMatchObject({
                fromBot: true,
                outcome: 'skipped'
            });
        });

        it('does not mark a viewer line as the bot', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            await deliver(alpha.broadcasterId, '!hello');

            expect(await client.waitFor('chat.message')).toMatchObject({
                fromBot: false,
                outcome: 'command'
            });
        });

        it('does not mark a reward-attached viewer line as the bot', async () => {
            /*
             * The distinction `fromBot` exists for. A reward-attached message
             * is `skipped` too — it arrives again as a redemption, so the chat
             * path declines it — but it is a VIEWER's line. Deriving the marker
             * from `skipped` alone would put the bot's wash on it and tell the
             * broadcaster their viewer was the bot.
             */
            const client = await connect(alpha.token);
            await client.waitFor('hello');

            const delivery = chatMessageDelivery(SECRET, {
                broadcasterUserId: alpha.broadcasterId,
                text: 'a song please',
                rewardId: 'reward-song-request'
            });
            await request(httpServer).post(EVENTSUB_WEBHOOK_PATH)
                .set(delivery.headers).send(delivery.body).expect(204);
            await transport.drain();

            expect(await client.waitFor('chat.message')).toMatchObject({
                outcome: 'skipped',
                fromBot: false
            });
        });

        it('greets a new client immediately rather than making it wait for chat', async () => {
            const client = await connect(beta.token);

            expect(await client.waitFor('hello')).toMatchObject({ type: 'hello', channelId: beta.id, login: 'livebeta' });
        });
    });

    describe('fan-out isolation', () => {
        it('never delivers one channel event to another channel socket', async () => {
            const alphaClient = await connect(alpha.token);
            const betaClient = await connect(beta.token);
            await alphaClient.waitFor('hello');
            await betaClient.waitFor('hello');

            await deliver(alpha.broadcasterId, '!hello');
            await alphaClient.waitFor('chat.message');

            // Give any mis-routed delivery time to arrive before asserting none did.
            await new Promise((r) => setTimeout(r, 150));
            expect(betaClient.of('chat.message')).toHaveLength(0);
        });

        it('keeps both correct under interleaved traffic', async () => {
            const alphaClient = await connect(alpha.token);
            const betaClient = await connect(beta.token);
            await alphaClient.waitFor('hello');
            await betaClient.waitFor('hello');

            for (let i = 0; i < 5; i++) {
                await deliver(alpha.broadcasterId, '!hello');
                await deliver(beta.broadcasterId, '!hello');
            }
            await new Promise((r) => setTimeout(r, 200));

            expect(alphaClient.of('chat.message')).toHaveLength(5);
            expect(betaClient.of('chat.message')).toHaveLength(5);
            for (const e of alphaClient.of('chat.message')) expect(e.channelId).toBe(alpha.id);
            for (const e of betaClient.of('chat.message')) expect(e.channelId).toBe(beta.id);
        });

        /**
         * THE ENRICHMENT CENTREPIECE.
         *
         * The two channels are given deliberately DIFFERENT fates in the same
         * moment, so a leak is visible in the payload rather than only in the
         * count: alpha runs a command, beta just chats. If an event crossed,
         * beta's dashboard would put a `CMD` chip on a line its viewer never
         * sent — a wrong story about someone else's channel, which is worse
         * than a missing line.
         */
        it('never carries one channel outcome onto another channel feed', async () => {
            const alphaClient = await connect(alpha.token);
            const betaClient = await connect(beta.token);
            await alphaClient.waitFor('hello');
            await betaClient.waitFor('hello');

            await deliver(alpha.broadcasterId, '!hello');
            await deliver(beta.broadcasterId, 'just chatting');
            await new Promise((r) => setTimeout(r, 200));

            const alphaEvents = alphaClient.of('chat.message');
            const betaEvents = betaClient.of('chat.message');

            expect(alphaEvents).toHaveLength(1);
            expect(betaEvents).toHaveLength(1);
            expect(alphaEvents[0]).toMatchObject({ channelId: alpha.id, outcome: 'command' });
            expect(betaEvents[0]).toMatchObject({ channelId: beta.id, outcome: 'none' });

            // Stated as its own assertion because it is the actual failure
            // mode: not "beta got extra events" but "beta got alpha's verdict".
            expect(betaEvents.some((e) => 'outcome' in e && e.outcome === 'command')).toBe(false);
            expect(alphaEvents.some((e) => 'outcome' in e && e.outcome === 'none')).toBe(false);
        });

        it('never carries one channel bot-reply marker onto another feed', async () => {
            const alphaClient = await connect(alpha.token);
            const betaClient = await connect(beta.token);
            await alphaClient.waitFor('hello');
            await betaClient.waitFor('hello');

            await deliver(alpha.broadcasterId, 'ALPHA hello', BOT_ID);
            await deliver(beta.broadcasterId, 'just chatting');
            await new Promise((r) => setTimeout(r, 200));

            const betaEvents = betaClient.of('chat.message');
            expect(betaEvents).toHaveLength(1);
            // A leaked wash would tell beta's broadcaster their viewer is the bot.
            expect(betaEvents.some((e) => 'fromBot' in e && e.fromBot === true)).toBe(false);
        });

        it('delivers to every socket a channel has open', async () => {
            const first = await connect(alpha.token);
            const second = await connect(alpha.token);
            await first.waitFor('hello');
            await second.waitFor('hello');

            await deliver(alpha.broadcasterId, '!hello');

            expect(await first.waitFor('chat.message')).toBeTruthy();
            expect(await second.waitFor('chat.message')).toBeTruthy();
        });
    });

    describe('the upgrade is the security boundary', () => {
        const expectRejected = async (url: string): Promise<void> => {
            const socket = new WebSocket(url);
            sockets.push(socket);

            await new Promise<void>((resolve, reject) => {
                socket.once('error', () => resolve());
                socket.once('open', () => reject(new Error('connection was accepted')));
                setTimeout(() => reject(new Error('neither opened nor errored')), 3000);
            });
        };

        it('refuses an upgrade with no token', async () => {
            await expectRejected(`ws://127.0.0.1:${port}${LIVE_PATH}`);
        });

        it('refuses a forged token', async () => {
            const forged = signJwt({ sub: alpha.broadcasterId, login: 'x' }, 'a-totally-different-secret-here', 900);
            await expectRejected(`ws://127.0.0.1:${port}${LIVE_PATH}?access_token=${forged}`);
        });

        it('refuses an expired token', async () => {
            const expired = signJwt({ sub: alpha.broadcasterId, login: 'x' }, JWT_SECRET, 60, Date.now() - 120_000);
            await expectRejected(`ws://127.0.0.1:${port}${LIVE_PATH}?access_token=${expired}`);
        });

        it('refuses a valid token for an account with no channel', async () => {
            const stranger = signJwt({ sub: 'no-such-broadcaster', login: 'stranger' }, JWT_SECRET, 900);
            await expectRejected(`ws://127.0.0.1:${port}${LIVE_PATH}?access_token=${stranger}`);
        });

        it('refuses a wrong path', async () => {
            await expectRejected(`ws://127.0.0.1:${port}/api/v1/not-live?access_token=${alpha.token}`);
        });
    });

    describe('connection hygiene', () => {
        it('drops a client from the fan-out when it disconnects', async () => {
            const client = await connect(alpha.token);
            await client.waitFor('hello');
            const before = live.connectionCount;

            client.socket.close();
            await new Promise((r) => setTimeout(r, 200));

            expect(live.connectionCount).toBeLessThan(before);
        });

        it('reaps a socket that stops responding to pings', async () => {
            // A laptop that closed its lid leaves a TCP connection that looks
            // open forever; every unreaped socket is a channel's events being
            // serialized to nowhere.
            //
            // Pausing the underlying stream is what makes this a *half-open*
            // connection rather than a closed one: the client never processes
            // the ping, so it never pongs, and the server gets no close event
            // either. Only the heartbeat can notice.
            const client = await connect(alpha.token);
            await client.waitFor('hello');
            const before = live.connectionCount;
            expect(before).toBeGreaterThan(0);

            (client.socket as unknown as { _socket: { pause: () => void } })._socket.pause();

            // heartbeatMs is 50 here, and reaping needs two sweeps: one to mark
            // it unanswered, the next to act on that.
            await new Promise((r) => setTimeout(r, 500));

            expect(live.connectionCount).toBe(before - 1);
        });
    });

    describe('publishing cannot hurt the pipeline', () => {
        it('a throwing subscriber never fails a chat message', async () => {
            const bus = createEventBus();
            bus.subscribe(() => { throw new Error('subscriber exploded'); });

            // The bus swallows listener failures by contract; proving it here
            // means a bad UI client can never stop the bot answering.
            expect(() => bus.publish('c1', {
                type: 'hello', channelId: 'c1', at: '', login: 'x'
            })).not.toThrow();
        });
    });
});
