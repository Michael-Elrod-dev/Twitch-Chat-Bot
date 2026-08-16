import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { bootstrapChannels, buildChannelSession, resolveBotIdentity, type ChannelDependencies } from './bootstrap.js';
import { SessionManager } from './session/sessionManager.js';
import { FakeTransport } from './transport/fakeTransport.js';
import { RecordingChatSink } from './services/chatSink.js';
import { StubAiService } from './services/aiService.js';
import { NoopAnalyticsSink } from './services/analytics.js';
import type { CacheManager } from './cache/cacheManager.js';
import type { ChannelRepositories } from './bootstrap.js';
import type { ChannelRecord } from './db/repositories/channelRepository.js';
import type { Database } from './db/client.js';
import type { Env } from './config/env.js';

const logger = pino({ level: 'silent' });

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const channel = (id: string, broadcasterId: string): ChannelRecord => ({
    id, twitchBroadcasterId: broadcasterId, twitchLogin: id, status: 'active'
});

function repositoriesFor(commandName: string, response: string): ChannelRepositories {
    return {
        commands: {
            listAll: async () => [{ name: commandName, responseText: response, handlerName: null, userLevel: 'everyone' }],
            updateUserLevel: vi.fn()
        },
        emotes: { listAll: async () => [] },
        settings: { get: async () => ({ aiEnabled: true, songRequestsEnabled: true, discordWebhookUrl: null }) },
        roles: { upsertRoles: vi.fn(async () => undefined), get: async () => null }
    } as unknown as ChannelRepositories;
}

describe('buildChannelSession', () => {
    let sink: RecordingChatSink;
    let deps: ChannelDependencies;

    beforeEach(() => {
        sink = new RecordingChatSink();
        deps = {
            repositories: (channelId) => repositoriesFor('!hello', `${channelId} says hi`),
            cache: nullCache(),
            logger,
            chatSink: sink,
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: 'bot-1', login: 'almosthadai', aiTriggers: ['almosthadai'] }
        };
    });

    it('wires the session to its own channel identity', () => {
        const session = buildChannelSession(deps, channel('c1', '1001'));

        expect(session.channelId).toBe('c1');
        expect(session.broadcasterTwitchId).toBe('1001');
    });

    it('routes replies to the sink tagged with the right channel and broadcaster', async () => {
        const session = buildChannelSession(deps, channel('c1', '1001'));
        await session.start();

        await session.handleEvent({
            kind: 'chat_message',
            messageId: 'm1',
            broadcasterTwitchId: '1001',
            chatter: {
                twitchUserId: 'u1', login: 'v', displayName: 'V',
                isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
            },
            text: '!hello'
        });

        expect(sink.sent).toEqual([{ channelId: 'c1', broadcasterTwitchId: '1001', text: 'c1 says hi' }]);
    });

    it('gives each channel its own repositories', () => {
        const calls: string[] = [];
        const session = buildChannelSession(
            { ...deps, repositories: (id) => { calls.push(id); return repositoriesFor('!x', 'y'); } },
            channel('c9', '9')
        );

        // The factory is called with this channel's id and nothing else, which
        // is what makes cross-tenant reads structurally impossible.
        expect(calls).toEqual(['c9']);
        expect(session.channelId).toBe('c9');
    });
});

describe('bootstrapChannels', () => {
    let manager: SessionManager;
    let transport: FakeTransport;
    let deps: ChannelDependencies;

    beforeEach(async () => {
        transport = new FakeTransport();
        manager = new SessionManager({ transport, logger });
        await manager.start();

        deps = {
            repositories: (channelId) => repositoriesFor('!hello', `${channelId} says hi`),
            cache: nullCache(),
            logger,
            chatSink: new RecordingChatSink(),
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: 'bot-1', login: 'almosthadai', aiTriggers: ['almosthadai'] }
        };
    });

    it('starts every active channel and subscribes each broadcaster', async () => {
        const result = await bootstrapChannels(deps, manager, [channel('c1', '1001'), channel('c2', '2002')]);

        expect(result).toEqual({ started: 2, failed: 0 });
        expect(manager.size).toBe(2);
        expect([...transport.subscribed].sort()).toEqual(['1001', '2002']);
    });

    it('keeps going when one channel fails to start', async () => {
        // A single bad row must not take the service down for every tenant.
        const failing: ChannelDependencies = {
            ...deps,
            repositories: (channelId) => channelId === 'bad'
                ? ({ commands: { listAll: async () => { throw new Error('table gone'); } } } as unknown as ChannelRepositories)
                : repositoriesFor('!hello', 'hi')
        };

        const result = await bootstrapChannels(failing, manager, [
            channel('bad', '1'), channel('good', '2')
        ]);

        expect(result).toEqual({ started: 1, failed: 1 });
        expect(manager.get('good')).toBeDefined();
        expect(manager.get('bad')).toBeUndefined();
    });

    it('is a no-op with no channels', async () => {
        expect(await bootstrapChannels(deps, manager, [])).toEqual({ started: 0, failed: 0 });
    });
});

describe('resolveBotIdentity', () => {
    const env = (overrides: Partial<Env> = {}): Env => ({ ...overrides } as Env);

    const dbReturning = (rows: unknown[]): Database =>
        ({ select: () => ({ from: () => ({ limit: async () => rows }) }) }) as unknown as Database;

    it('prefers the database row', async () => {
        const identity = await resolveBotIdentity(
            dbReturning([{ twitchUserId: 'db-bot', twitchLogin: 'DbBot' }]),
            env({ BOT_TWITCH_USER_ID: 'env-bot' }),
            logger
        );

        expect(identity.twitchUserId).toBe('db-bot');
        expect(identity.aiTriggers).toEqual(['dbbot']);
    });

    it('falls back to the environment before onboarding has happened', async () => {
        const identity = await resolveBotIdentity(dbReturning([]), env({ BOT_TWITCH_USER_ID: 'env-bot' }), logger);

        expect(identity.twitchUserId).toBe('env-bot');
    });

    it('does not fail the boot when neither is configured', async () => {
        // A missing bot identity is a warning, not a crash: the server still
        // serves, it simply cannot recognise its own messages.
        const identity = await resolveBotIdentity(dbReturning([]), env(), logger);

        expect(identity.twitchUserId).toBe('');
        expect(identity.aiTriggers).toEqual(['almosthadai']);
    });

    it('survives a database that cannot be read', async () => {
        const broken = { select: () => { throw new Error('connection lost'); } } as unknown as Database;

        await expect(resolveBotIdentity(broken, env({ BOT_TWITCH_USER_ID: 'env-bot' }), logger)).resolves.toMatchObject({
            twitchUserId: 'env-bot'
        });
    });

    it('parses an explicit trigger list', async () => {
        const identity = await resolveBotIdentity(dbReturning([]), env({ AI_TRIGGERS: 'Bot, Buddy , ' }), logger);

        expect(identity.aiTriggers).toEqual(['bot', 'buddy']);
    });
});
