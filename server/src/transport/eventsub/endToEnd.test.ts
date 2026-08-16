import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../http/app.js';
import { EventSubWebhookTransport } from './webhookTransport.js';
import { EVENTSUB_WEBHOOK_PATH } from './webhook.js';
import { SubscriptionReconciler } from './subscriptionReconciler.js';
import { FakeHelixClient } from './helixClient.js';
import { chatMessageDelivery, streamOnlineDelivery, revocationDelivery, type SignedDelivery } from './synthetic.js';
import { SessionManager } from '../../session/sessionManager.js';
import { buildChannelSession, type ChannelDependencies, type ChannelRepositories } from '../../bootstrap.js';
import { RecordingChatSink } from '../../services/chatSink.js';
import { StubAiService } from '../../services/aiService.js';
import { NoopAnalyticsSink } from '../../services/analytics.js';
import type { CacheManager } from '../../cache/cacheManager.js';
import type { CommandRecord } from '../../db/repositories/commandRepository.js';
import type { EmoteRecord } from '../../db/repositories/emoteRepository.js';
import type { ChannelRecord } from '../../db/repositories/channelRepository.js';

/**
 * THE EXIT CRITERION, as a test.
 *
 * A signed synthetic `channel.chat.message` is POSTed to the real webhook route
 * and a command response comes out at the ChatSink — for two channels at once,
 * through the real signature check, the real queue, the real session router, the
 * real composition root and the real pipeline. Everything between the HTTP
 * request and the outbound message is production code; only Postgres, Redis and
 * Twitch are substituted.
 *
 * The compose-level version of this same journey is documented in README
 * "Local development"; this is the version that runs on every commit.
 */

const logger = pino({ level: 'silent' });
const SECRET = 'end-to-end-test-secret-value';
const BOT_ID = 'bot-999';

const ALPHA: ChannelRecord = {
    id: 'channel-alpha', twitchBroadcasterId: '1001', twitchLogin: 'alpha', status: 'active'
};
const BETA: ChannelRecord = {
    id: 'channel-beta', twitchBroadcasterId: '2002', twitchLogin: 'beta', status: 'active'
};

/** A cache that never serves anything, so every lookup exercises the real path. */
const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

interface ChannelFixture {
    commands: CommandRecord[];
    emotes: EmoteRecord[];
    aiEnabled: boolean;
}

/** In-memory stand-ins for the four channel-scoped repositories. */
function fakeRepositories(fixture: ChannelFixture): ChannelRepositories {
    return {
        commands: { listAll: async () => fixture.commands, updateUserLevel: vi.fn(async () => undefined) },
        emotes: { listAll: async () => fixture.emotes },
        settings: {
            get: async () => ({
                aiEnabled: fixture.aiEnabled, songRequestsEnabled: true, discordWebhookUrl: null
            })
        },
        roles: { upsertRoles: vi.fn(async () => undefined), get: async () => null }
    } as unknown as ChannelRepositories;
}

const FIXTURES: Record<string, ChannelFixture> = {
    [ALPHA.id]: {
        commands: [{ name: '!discord', responseText: 'ALPHA discord link', handlerName: null, userLevel: 'everyone' }],
        emotes: [{ triggerText: 'hello', responseText: 'ALPHA waves' }],
        aiEnabled: true
    },
    [BETA.id]: {
        commands: [
            { name: '!discord', responseText: 'BETA discord link', handlerName: null, userLevel: 'everyone' },
            { name: '!mods', responseText: 'beta mods only', handlerName: null, userLevel: 'mod' }
        ],
        emotes: [{ triggerText: 'hello', responseText: 'BETA nods' }],
        aiEnabled: true
    }
};

describe('webhook to ChatSink, end to end', () => {
    let app: ReturnType<typeof createApp>;
    let transport: EventSubWebhookTransport;
    let manager: SessionManager;
    let sink: RecordingChatSink;
    let helix: FakeHelixClient;

    beforeEach(async () => {
        sink = new RecordingChatSink();
        helix = new FakeHelixClient();

        const dependencies: ChannelDependencies = {
            repositories: (channelId) => fakeRepositories(FIXTURES[channelId] as ChannelFixture),
            cache: nullCache(),
            logger,
            chatSink: sink,
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: BOT_ID, login: 'almosthadai', aiTriggers: ['almosthadai'] }
        };

        transport = new EventSubWebhookTransport({
            secret: SECRET,
            logger,
            maxSkewMs: 600_000,
            reconciler: new SubscriptionReconciler({
                client: helix,
                logger,
                callbackUrl: `https://example.test${EVENTSUB_WEBHOOK_PATH}`,
                secret: SECRET,
                botUserId: BOT_ID
            }),
            dryRunSubscriptions: false
        });

        manager = new SessionManager({ transport, logger });
        await manager.start();
        for (const channel of [ALPHA, BETA]) {
            await manager.add(buildChannelSession(dependencies, channel));
        }

        app = createApp({ logger, version: 'test', rawBodyRouters: [transport.router] });
    });

    afterEach(async () => {
        await manager.stopAll();
    });

    const post = (delivery: SignedDelivery) =>
        request(app).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body);

    /** Posts, then waits for the queue: an acknowledgement does not mean processed. */
    const deliver = async (delivery: SignedDelivery, expectedStatus = 204): Promise<void> => {
        await post(delivery).expect(expectedStatus);
        await transport.drain();
    };

    it('turns a signed chat message into a command response', async () => {
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' }));

        expect(sink.sent).toHaveLength(1);
        expect(sink.sent[0]).toMatchObject({
            channelId: ALPHA.id,
            broadcasterTwitchId: '1001',
            text: 'ALPHA discord link'
        });
    });

    it('answers the same command differently in each channel', async () => {
        // The two-channel proof, now over the real HTTP path.
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' }));
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '2002', text: '!discord' }));

        expect(sink.textsFor(ALPHA.id)).toEqual(['ALPHA discord link']);
        expect(sink.textsFor(BETA.id)).toEqual(['BETA discord link']);
    });

    it('resolves emotes per channel', async () => {
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hello' }));
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '2002', text: 'hello' }));

        expect(sink.textsFor(ALPHA.id)).toEqual(['ALPHA waves']);
        expect(sink.textsFor(BETA.id)).toEqual(['BETA nods']);
    });

    it('applies the badge-derived permission level', async () => {
        // Roles arrive as Twitch badges and end up deciding a permission check —
        // the whole translation, exercised in one test.
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '2002', text: '!mods' }));
        expect(sink.textsFor(BETA.id)).toEqual([]);

        await deliver(chatMessageDelivery(SECRET, {
            broadcasterUserId: '2002',
            text: '!mods',
            badges: [{ set_id: 'moderator', id: '1', info: '' }]
        }));
        expect(sink.textsFor(BETA.id)).toEqual(['beta mods only']);
    });

    it('skips a message the bot sent itself', async () => {
        await deliver(chatMessageDelivery(SECRET, {
            broadcasterUserId: '1001', text: '!discord', chatterUserId: BOT_ID
        }));

        expect(sink.sent).toHaveLength(0);
    });

    it('skips a reward-attached message', async () => {
        await deliver(chatMessageDelivery(SECRET, {
            broadcasterUserId: '1001', text: '!discord', rewardId: 'reward-7'
        }));

        expect(sink.sent).toHaveLength(0);
    });

    it('acknowledges before the work is done', async () => {
        // The response must not wait on the pipeline: Twitch revokes endpoints
        // that answer slowly. A fast pipeline would let this pass for the wrong
        // reason, so the sink is held open until after the acknowledgement.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        vi.spyOn(sink, 'send').mockImplementation(async (message) => {
            await held;
            sink.sent.push(message);
        });

        const response = await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' }));

        expect(response.status).toBe(204);
        expect(sink.sent).toHaveLength(0); // acknowledged while the work is still blocked

        release();
        await transport.drain();
        expect(sink.sent).toHaveLength(1);
    });

    it('drops a redelivery without answering twice', async () => {
        const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' }, 'retry-me');

        await deliver(delivery);
        await deliver(delivery);

        expect(sink.sent).toHaveLength(1);
    });

    it('never lets a forged message reach a session', async () => {
        await deliver(chatMessageDelivery('not-the-secret', { broadcasterUserId: '1001', text: '!discord' }), 403);

        expect(sink.sent).toHaveLength(0);
    });

    it('drops an event for a broadcaster nobody is running', async () => {
        await deliver(chatMessageDelivery(SECRET, { broadcasterUserId: '9999', text: '!discord' }));

        expect(sink.sent).toHaveLength(0);
    });

    it('tracks stream state through the same route', async () => {
        await deliver(streamOnlineDelivery(SECRET, '1001'));

        expect(manager.get(ALPHA.id)?.isLive()).toBe(true);
        expect(manager.get(BETA.id)?.isLive()).toBe(false);
    });

    it('subscribes both broadcasters through the reconciler', () => {
        expect(transport.subscribedBroadcasters.sort()).toEqual(['1001', '2002']);
        expect(helix.created.map((c) => c.condition['broadcaster_user_id']))
            .toEqual(expect.arrayContaining(['1001', '2002']));
    });

    it('reports a revocation to its handler', async () => {
        const seen: string[] = [];
        const revoking = new EventSubWebhookTransport({
            secret: SECRET, logger, maxSkewMs: 600_000,
            onRevocation: (subscription) => { seen.push(subscription.condition['broadcaster_user_id'] ?? ''); }
        });
        const revokingApp = createApp({ logger, version: 'test', rawBodyRouters: [revoking.router] });

        const delivery = revocationDelivery(SECRET, '1001');
        await request(revokingApp).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body).expect(204);

        expect(seen).toEqual(['1001']);
    });

    it('keeps both channels correct under interleaved traffic', async () => {
        const posts: Promise<unknown>[] = [];
        for (let i = 0; i < 15; i++) {
            posts.push(post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' })));
            posts.push(post(chatMessageDelivery(SECRET, { broadcasterUserId: '2002', text: '!discord' })));
        }
        await Promise.all(posts);
        await transport.drain();

        expect(sink.textsFor(ALPHA.id)).toHaveLength(15);
        expect(sink.textsFor(BETA.id)).toHaveLength(15);
        expect(new Set(sink.textsFor(ALPHA.id))).toEqual(new Set(['ALPHA discord link']));
        expect(new Set(sink.textsFor(BETA.id))).toEqual(new Set(['BETA discord link']));
    });

    it('drains the queue on shutdown rather than dropping acknowledged events', async () => {
        // The sink is deliberately slow. Without it, the work would finish on
        // its own before the assertion and this would pass whether or not
        // shutdown actually drained anything.
        vi.spyOn(sink, 'send').mockImplementation(async (message) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            sink.sent.push(message);
        });

        await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' })).expect(204);
        expect(sink.sent).toHaveLength(0);

        // An event Twitch believes was accepted must still be processed.
        await manager.stopAll();

        expect(sink.sent).toHaveLength(1);
    });
});
