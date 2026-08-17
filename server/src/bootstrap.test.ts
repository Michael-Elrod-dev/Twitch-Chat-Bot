import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { pino } from 'pino';
import { randomBytes } from 'node:crypto';
import { bootstrapChannels, buildChannelSession, resolveBotIdentity, type ChannelDependencies } from './bootstrap.js';
import { connectTestDatabase } from './db/testing.js';
import type { DbHandle } from './db/client.js';
import { ChannelRepository } from './db/repositories/channelRepository.js';
import { ChannelTokenRepository } from './db/repositories/channelTokenRepository.js';
import { ChannelRewardRepository } from './db/repositories/channelRewardRepository.js';
import { createTokenCipher } from './crypto/tokenCipher.js';
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
    id, twitchBroadcasterId: broadcasterId, twitchLogin: id, status: 'active', enabled: true
});

function repositoriesFor(commandName: string, response: string): ChannelRepositories {
    return {
        commands: {
            listAll: async () => [{ name: commandName, responseText: response, handlerName: null, userLevel: 'everyone' }],
            updateUserLevel: vi.fn(), updateDescription: vi.fn()
        },
        emotes: { listAll: async () => [] },
        settings: { get: async () => ({
            aiEnabled: true,
            aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 },
            songRequestsEnabled: true,
            discordWebhookUrl: null
        }) },
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

    /**
     * The coverage hole that let the same bug ship twice.
     *
     * Every test above builds deps WITHOUT `db`/`cipher`/`spotifyOAuth`, so the
     * optional-capability half of this function was never executed by anything.
     * That is where both monitor defects lived: first the session was never told
     * to start it, then — in the fix itself — the monitor was built and never
     * handed over. Both compiled, both passed the suite, both shipped.
     *
     * Wiring is only observable through behaviour, so this asserts the lifecycle
     * the session is supposed to drive rather than reaching for a private field.
     */
    it('hands the playback monitor to the session when Spotify is configured', async () => {
        const lines: string[] = [];
        const recording = pino({ level: 'info' }, {
            write: (line: string) => { lines.push(JSON.parse(line).msg as string); }
        });

        const session = buildChannelSession({
            ...deps,
            logger: recording,
            // Enough of a database for the stream service to find no open
            // stream; this test is about the monitor, not about streams.
            db: {
                select: () => ({
                    from: () => ({
                        where: () => ({ orderBy: () => ({ limit: async () => [] }) })
                    })
                })
            } as unknown as Database,
            // NonNullable, not the bare indexed type: `cipher?:` makes
            // ChannelDependencies['cipher'] include undefined, and under
            // exactOptionalPropertyTypes an optional property may be absent or
            // a TokenCipher — never explicitly undefined. This test does supply
            // one, so the cast should say so.
            cipher: {} as unknown as NonNullable<ChannelDependencies['cipher']>,
            spotifyOAuth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://x/cb' }
        }, channel('c1', '1001'));

        await session.start();
        expect(lines).toContain('Playback monitor started');

        // The other half: a monitor that outlives its session polls Spotify for
        // a channel the bot is no longer running.
        await session.stop();
        expect(lines).toContain('Playback monitor stopped');
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

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Task 0 of P1-WP4.3 — the coverage debt named in the WP4.2 report.
 *
 * The monitor bug shipped twice through a hole in this file: every test above
 * builds dependencies WITHOUT `db`/`cipher`/`helix`/`twitchOAuth`, so the
 * optional-capability half of `buildChannelSession` was executed by nothing.
 * One branch of that half (the monitor) is now covered. These close the other
 * two — the redemption pipeline and the song toggle.
 *
 * Both assert through behaviour reaching a real collaborator, because "was it
 * constructed" is not the failure mode. The failure mode is "constructed and
 * never connected to anything", which only an observable effect can catch.
 */
describeDb('composition root: redemption + song-toggle wiring', () => {
    let handle: DbHandle;
    let channelId: string;
    let sink: RecordingChatSink;

    const cipher = createTokenCipher(randomBytes(32).toString('base64'));

    /** Records what the composition root actually reaches, if anything. */
    class SpyHelix {
        readonly statuses: { redemptionId: string; status: string }[] = [];
        readonly toggles: { rewardId: string; enabled: boolean }[] = [];

        async updateRedemptionStatus(
            _broadcasterId: string, _token: string, _rewardId: string, redemptionId: string, status: string
        ): Promise<void> {
            this.statuses.push({ redemptionId, status });
        }

        async setCustomRewardEnabled(
            _broadcasterId: string, _token: string, rewardId: string, enabled: boolean
        ): Promise<void> {
            this.toggles.push({ rewardId, enabled });
        }
    }

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        channelId = (await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: '4242', twitchLogin: 'wiringchannel', displayName: null
        })).id;

        // Settlement needs a broadcaster token; a far-future expiry keeps the
        // provider on the stored value instead of attempting a real refresh.
        await new ChannelTokenRepository(handle.db, channelId, cipher).upsert('twitch', {
            accessToken: 'broadcaster-access',
            refreshToken: 'broadcaster-refresh',
            expiresAt: new Date(Date.now() + 3_600_000),
            scopes: ['channel:manage:redemptions']
        });

        await new ChannelRewardRepository(handle.db, channelId).upsert({
            kind: 'add_quote', rewardId: 'reward-quote', title: 'Add a quote'
        });

        // api_usage references viewers. Production creates the row through the
        // roles repository on the chatter's first message; these tests stub that
        // repository, so the identity has to exist up front.
        await handle.sql`
            insert into viewers (twitch_user_id, login) values ('8', 'asker')
            on conflict (twitch_user_id) do nothing`;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const depsWithCapabilities = (helix: SpyHelix): ChannelDependencies => ({
        repositories: () => repositoriesFor('!hello', 'hi'),
        cache: nullCache(),
        logger,
        ai: new StubAiService(),
        analytics: new NoopAnalyticsSink(),
        bot: { twitchUserId: 'bot-1', login: 'almosthadai', aiTriggers: ['almosthadai'] },
        chatSink: sink,
        db: handle.db,
        cipher,
        helix: helix as unknown as NonNullable<ChannelDependencies['helix']>,
        twitchOAuth: { clientId: 'id', clientSecret: 'secret' }
    });

    beforeEach(() => {
        sink = new RecordingChatSink();
    });

    it('routes a redemption through the pipeline to settlement', async () => {
        const helix = new SpyHelix();
        const session = buildChannelSession(
            depsWithCapabilities(helix),
            channel(channelId, '4242')
        );
        await session.start();

        await session.handleEvent({
            kind: 'redemption',
            messageId: 'r1',
            broadcasterTwitchId: '4242',
            redemptionId: 'redemption-1',
            rewardId: 'reward-quote',
            rewardTitle: 'Add a quote',
            // Malformed on purpose: the refund path is the loudest proof that
            // the whole chain — routing, handler, settlement, Helix — is joined.
            userInput: 'no attribution here',
            redeemer: { twitchUserId: '99', login: 'viewer', displayName: 'Viewer' }
        });

        expect(helix.statuses).toEqual([{ redemptionId: 'redemption-1', status: 'CANCELED' }]);
        await session.stop();
    });

    it('feeds the live stream into the AI prompt and the rate-limit bucket', async () => {
        /*
         * Added because reintroducing the P1-WP4.1 flag — `streamContext: () =>
         * null` in the composition root — broke NOTHING. The stream service and
         * its context were fully tested; the wire from one to the other was not,
         * which is the same hole that shipped the monitor bug twice.
         *
         * So this asserts through the only thing that proves the wire exists:
         * what Claude is actually sent.
         */
        const prompts: string[] = [];
        const helix = new SpyHelix();

        // The test database persists between runs, so a count assertion has to
        // start from a known state rather than from whatever earlier runs left.
        await handle.sql`delete from api_usage where channel_id = ${channelId}`;
        const session = buildChannelSession({
            ...depsWithCapabilities(helix),
            helix: {
                ...helix,
                getStream: async () => ({
                    id: '55', userId: '4242',
                    startedAt: '2026-08-16T10:00:00Z',
                    title: 'ranked climb', gameName: 'Chess'
                })
            } as unknown as NonNullable<ChannelDependencies['helix']>,
            claude: {
                complete: async (request: { system: string; userMessage: string }) => {
                    prompts.push(`${request.system}\n${request.userMessage}`);
                    return { ok: true, text: 'answer' };
                }
            } as unknown as NonNullable<ChannelDependencies['claude']>,
            repositories: () => ({
                commands: { listAll: async () => [], updateUserLevel: vi.fn(), updateDescription: vi.fn() },
                emotes: { listAll: async () => [] },
                settings: { get: async () => ({
                    aiEnabled: true,
                    aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 },
                    songRequestsEnabled: true,
                    discordWebhookUrl: null
                }) },
                roles: { upsertRoles: vi.fn(async () => undefined), get: async () => null },
                quotes: { add: vi.fn(async () => undefined) }
            }) as unknown as ChannelRepositories
        }, channel(channelId, '4242'));

        await session.start();

        await session.handleEvent({
            kind: 'stream_online',
            messageId: 'so-1',
            broadcasterTwitchId: '4242',
            streamId: `wiring-${Date.now()}`,
            startedAt: '2026-08-16T10:00:00Z'
        });

        await session.handleEvent({
            kind: 'chat_message',
            messageId: 'm-ai',
            broadcasterTwitchId: '4242',
            chatter: {
                twitchUserId: '8', login: 'asker', displayName: 'Asker',
                isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
            },
            text: 'almosthadai what game is this'
        });

        expect(prompts.join('')).toContain('Chess');

        /*
         * The bucket half, and it needs its own assertion: reverting
         * `currentStreamId` to null passed the prompt check above, because a
         * test that names two things and checks one is a test that lies about
         * its own coverage.
         *
         * Usage charged against the stream's uuid — not against the offline
         * bucket — is what makes a viewer's allowance reset per stream.
         */
        const usage = await handle.sql<{ stream_id: string | null }[]>`
            select stream_id from api_usage
            where channel_id = ${channelId} and twitch_user_id = '8'`;
        expect(usage).toHaveLength(1);
        expect(usage[0]?.stream_id).not.toBeNull();

        await session.stop();
    });

    it('registers the song-toggle handler against the real reward', async () => {
        const helix = new SpyHelix();
        await new ChannelRewardRepository(handle.db, channelId).upsert({
            kind: 'song_request', rewardId: 'reward-song', title: 'Song Request'
        });

        const session = buildChannelSession({
            ...depsWithCapabilities(helix),
            // A command row pointing at the declarative handler, exactly as the
            // owner's production rows do.
            repositories: () => ({
                commands: {
                    listAll: async () => [
                        { name: '!songs', responseText: null, handlerName: 'toggleSongs', userLevel: 'mod' }
                    ],
                    updateUserLevel: vi.fn(), updateDescription: vi.fn()
                },
                emotes: { listAll: async () => [] },
                settings: {
                    get: async () => ({
                        aiEnabled: true,
                        aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 },
                        songRequestsEnabled: true,
                        discordWebhookUrl: null
                    }),
                    update: vi.fn(async () => undefined)
                },
                roles: { upsertRoles: vi.fn(async () => undefined), get: async () => null },
                quotes: { add: vi.fn(async () => undefined) }
            }) as unknown as ChannelRepositories
        }, channel(channelId, '4242'));

        await session.start();

        await session.handleEvent({
            kind: 'chat_message',
            messageId: 'm-toggle',
            broadcasterTwitchId: '4242',
            chatter: {
                twitchUserId: '7', login: 'mod', displayName: 'Mod',
                isModerator: true, isVip: false, isSubscriber: false, isBroadcaster: false
            },
            text: '!songs off'
        });

        // The toggle reaching Helix proves songToggle was built AND handed to
        // the CommandManager. Built-but-unregistered is the exact shape of the
        // monitor bug this task exists to prevent recurring.
        expect(helix.toggles).toEqual([{ rewardId: 'reward-song', enabled: false }]);
        await session.stop();
    });
});
