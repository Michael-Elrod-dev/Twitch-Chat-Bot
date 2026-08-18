import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { AnalyticsRepository } from '../db/repositories/analyticsRepository.js';
import { createStatsHandlers } from './statsHandlers.js';
import { createThirdPartyHandlers, seedFor, DEFAULT_IMAGE_SEED_SALT } from './thirdPartyHandlers.js';
import type { HandlerContext } from './handlers.js';
import { pino } from 'pino';
import { buildChannelSession, type ChannelDependencies } from '../bootstrap.js';
import { StubAiService } from '../services/aiService.js';
import { QuoteRepository } from '../db/repositories/quoteRepository.js';
import { createTokenCipher } from '../crypto/tokenCipher.js';
import { randomBytes } from 'node:crypto';
import type { CacheManager } from '../cache/cacheManager.js';

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

function contextFor(args: string[], login: string, replies: string[]): HandlerContext {
    return {
        channelId: 'c',
        args,
        chatter: {
            twitchUserId: 'caller', login, displayName: login,
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        },
        reply: async (text: string) => { replies.push(text); }
    };
}

describe('!fursona and !waifu', () => {
    const handlers = createThirdPartyHandlers();

    const run = async (name: string, args: string[], login: string, salt?: string): Promise<string> => {
        const replies: string[] = [];
        const registry = salt === undefined ? handlers : createThirdPartyHandlers({ salt });
        await registry[name]?.handler(contextFor(args, login, replies));
        return replies[0] ?? '';
    };

    it('gives the same person the same picture every time', async () => {
        // The whole point of the command: yours is yours. A hash change would
        // silently reassign everyone's.
        const first = await run('fursona', [], 'someviewer');
        const second = await run('fursona', [], 'someviewer');

        expect(first).toBe(second);
    });

    it('gives different people different pictures', async () => {
        expect(await run('fursona', [], 'personone')).not.toBe(await run('fursona', [], 'persontwo'));
    });

    it('targets the named person, stripping the @', async () => {
        expect(await run('fursona', ['@named'], 'caller')).toContain('@named,');
    });

    it('points fursona at the host verified alive', async () => {
        expect(await run('fursona', [], 'someviewer'))
            .toMatch(/https:\/\/thisfursonadoesnotexist\.com\/v2\/jpgs-2x\/seed\d{5}\.jpg/);
    });

    it('does not point waifu at the dead arfa.dev path', async () => {
        /*
         * arfa.dev/waifu-ed/ returns 404 for the whole path, not just the
         * hashed filename. Pointing at it would ship a command that posts a
         * broken link to every viewer who runs it.
         */
        const reply = await run('waifu', [], 'someviewer');

        expect(reply).not.toContain('arfa.dev');
        expect(reply).toMatch(/https:\/\/www\.thiswaifudoesnotexist\.net\/example-\d+\.jpg/);
    });

    describe('salt eras', () => {
        /*
         * The owner asked for a reset: everyone's picture reassigned, once.
         * Rather than a one-off shuffle, the assignment is keyed on a salt, so
         * a wipe is a salt bump and the next one costs an env change.
         */
        it('gives the same person a different picture in a different era', async () => {
            const before = await run('waifu', [], 'someviewer', 'era-one');
            const after = await run('waifu', [], 'someviewer', 'era-two');

            expect(before).not.toBe(after);
        });

        it('resets fursona and waifu together', async () => {
            // One salt covers both commands, so a wipe is genuinely a wipe.
            expect(await run('fursona', [], 'someviewer', 'era-one'))
                .not.toBe(await run('fursona', [], 'someviewer', 'era-two'));
        });

        it('holds the mapping steady within one era', async () => {
            // "Yours is yours" has to survive every restart until a bump.
            const first = await run('waifu', [], 'someviewer', 'era-one');
            const second = await run('waifu', [], 'someviewer', 'era-one');

            expect(first).toBe(second);
        });

        it('moves everyone, not a lucky few', async () => {
            /*
             * A salt that only reshuffled some names would leave viewers
             * wondering why theirs did not change. Checked across a spread of
             * logins rather than one, which a single sample could pass by luck.
             */
            const names = ['aaa', 'bob', 'charlie', 'dee', 'eve', 'frank', 'grace', 'heidi'];
            const moved = names.filter((n) =>
                seedFor(n, 1, 100_000, 'era-one') !== seedFor(n, 1, 100_000, 'era-two'));

            expect(moved).toEqual(names);
        });

        it('resets against the era that shipped before the salt existed', async () => {
            // The pre-salt seed was hash(username) with no prefix at all; the
            // reset is only real if the new default moves off it.
            const preSalt = seedFor('someviewer', 1, 100_000, '').replace(/^:/, '');
            const current = seedFor('someviewer', 1, 100_000, DEFAULT_IMAGE_SEED_SALT);

            expect(current).not.toBe(preSalt);
        });

        it('treats @Name and @name as the same person', async () => {
            // The IMAGE must match; the greeting deliberately echoes back the
            // capitalization the viewer typed.
            const url = (reply: string) => /(https:\S+)/.exec(reply)?.[1];

            expect(url(await run('waifu', ['@SomeViewer'], 'caller')))
                .toBe(url(await run('waifu', ['@someviewer'], 'caller')));
        });
    });

    it('keeps the waifu seed inside the range the host serves', async () => {
        for (const name of ['aaa', 'zzz', 'a-very-long-login-name', 'x']) {
            const seed = Number(/example-(\d+)\.jpg/.exec(await run('waifu', [], name))?.[1]);
            expect(seed).toBeGreaterThanOrEqual(1);
            expect(seed).toBeLessThanOrEqual(100_000);
        }
    });
});

describeDb('!chats, !topchats and !follow', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    const FOLLOWED_AT = new Date('2024-03-05T08:30:00Z');

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        const channels = new ChannelRepository(handle.db);
        alphaId = (await channels.upsert({
            twitchBroadcasterId: `lf-a-${Date.now()}`, twitchLogin: 'alphalast', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `lf-b-${Date.now()}`, twitchLogin: 'betalast', displayName: null
        })).id;

        const alphaRoles = new ChannelRoleRepository(handle.db, alphaId);
        const noRoles = { isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false };

        await alphaRoles.upsertRoles('busy', 'busyviewer', noRoles);
        await alphaRoles.upsertRoles('quiet', 'quietviewer', noRoles);
        await new ChannelRoleRepository(handle.db, betaId).upsertRoles('busy', 'busyviewer', noRoles);

        const analytics = new AnalyticsRepository(handle.db, alphaId);
        for (let i = 0; i < 5; i++) await analytics.recordInteraction('busy', 'message');
        await analytics.recordInteraction('busy', 'command');
        await analytics.recordInteraction('busy', 'redemption');
        await analytics.recordInteraction('quiet', 'message');

        // Follows alpha, not beta. The channel-relative correction.
        await handle.sql`
            update channel_roles set followed_at = ${FOLLOWED_AT.toISOString()}::timestamptz
            where channel_id = ${alphaId} and twitch_user_id = 'busy'`;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const handlersFor = (channelId: string) => createStatsHandlers({
        analytics: new AnalyticsRepository(handle.db, channelId),
        roles: new ChannelRoleRepository(handle.db, channelId)
    });

    const run = async (channelId: string, name: string, args: string[], login = 'caller'): Promise<string> => {
        const replies: string[] = [];
        await handlersFor(channelId)[name]?.handler(contextFor(args, login, replies));
        return replies[0] ?? '';
    };

    describe('!chats', () => {
        it('breaks the totals down by kind', async () => {
            expect(await run(alphaId, 'combinedStats', ['@busyviewer']))
                .toBe('@busyviewer has 7 total interactions (5 messages, 1 commands, 1 redemptions)');
        });

        it('reports the caller when no name is given', async () => {
            expect(await run(alphaId, 'combinedStats', [], 'quietviewer')).toContain('1 total interactions');
        });

        it('distinguishes never-seen from zero', async () => {
            // "0 interactions" would be a claim about someone we have no record
            // of at all.
            expect(await run(alphaId, 'combinedStats', ['@nobody'])).toContain('no recorded activity');
        });

        it('does not leak another channel totals', async () => {
            // The same person, busy in alpha and silent in beta.
            expect(await run(betaId, 'combinedStats', ['@busyviewer'])).toContain('no recorded activity');
        });
    });

    describe('!topchats', () => {
        it('ranks by total interactions', async () => {
            expect(await run(alphaId, 'topStats', []))
                .toBe('Top 2 Most Active Viewers: 1. busyviewer | 2. quietviewer');
        });

        it('says so rather than printing an empty list', async () => {
            expect(await run(betaId, 'topStats', [])).toBe('No chat activity recorded yet.');
        });
    });

    describe('!follow', () => {
        it('answers with the follow date and how long ago', async () => {
            const reply = await run(alphaId, 'followAge', ['@busyviewer']);

            expect(reply).toContain('@busyviewer followed on 03/05/24.');
            expect(reply).toMatch(/\d+ years?, .* ago\.$/);
        });

        it('is channel-relative: following alpha is not following beta', async () => {
            /*
             * A single global `viewers.followed_at` would claim this person
             * follows every channel the bot serves.
             */
            expect(await run(betaId, 'followAge', ['@busyviewer']))
                .toContain('is not following this channel');
        });

        it('says so when the viewer is known but has no follow date', async () => {
            expect(await run(alphaId, 'followAge', ['@quietviewer']))
                .toContain('is not following this channel');
        });
    });
});

describeDb('every production command row has a handler', () => {
    /**
     * Every production command row must resolve to a handler this build has.
     *
     * These are the `handler_name` values in the owner's production `commands`
     * table. A row naming a handler this build does not have is not a crash. The
     * pipeline logs "Command references an unknown handler" and answers nothing,
     * so the failure mode is a command that silently stops working.
     *
     * The check is mechanical because comparing the two lists by hand misses the
     * factory-built handlers and only matches the inline literals.
     */
    const PRODUCTION_HANDLERS = [
        'advice', 'combinedStats', 'currentSong', 'followAge', 'fursona',
        'lastSong', 'modCommands', 'nextSong', 'queueInfo', 'quoteHandler',
        'roast', 'skipSong', 'toggleAI', 'toggleSongs', 'topStats', 'uptime',
        'waifu'
    ];

    let handle: DbHandle;
    let channelId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        channelId = (await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: `gate-${Date.now()}`, twitchLogin: 'gatechannel', displayName: null
        })).id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    it('registers every one of them through the real composition root', async () => {
        /*
         * Built through buildChannelSession rather than by calling the factories
         * directly: a handler that exists but is never registered is precisely
         * the bug this project has now shipped three times.
         */
        const unknown: string[] = [];
        const recording = pino({ level: 'warn' }, {
            write: (line: string) => {
                const entry = JSON.parse(line) as { msg?: string; handler?: string };
                if (entry.msg?.includes('unknown handler') && entry.handler) unknown.push(entry.handler);
            }
        });

        const session = buildChannelSession({
            // Annotated rather than inferred: the `as unknown as` below (needed
            // because HelixApi is a class the stub cannot structurally satisfy)
            // strips the contextual type from this whole literal.
            repositories: (id: string) => buildRepositories(handle, id, PRODUCTION_HANDLERS),
            cache: nullCache(),
            logger: recording,
            chatSink: { send: async () => undefined },
            ai: new StubAiService(),
            analytics: { recordInteraction: async () => undefined },
            bot: { twitchUserId: 'bot-1', login: 'almosthadai', aiTriggers: ['almosthadai'] },
            // A production-shaped channel: the song handlers only exist where
            // Spotify and the broadcaster-token credentials do, so a thinner
            // dependency set would under-report what production registers.
            db: handle.db,
            cipher: createTokenCipher(randomBytes(32).toString('base64')),
            helix: {
                updateRedemptionStatus: async () => undefined,
                setCustomRewardEnabled: async () => undefined,
                getStream: async () => null,
                getChatters: async () => []
            },
            twitchOAuth: { clientId: 'id', clientSecret: 'secret' },
            spotifyOAuth: { clientId: 'sid', clientSecret: 'ssecret', redirectUri: 'https://x/cb' }
        } as unknown as ChannelDependencies, {
            id: channelId, twitchBroadcasterId: '4242', twitchLogin: 'gatechannel', status: 'active', enabled: true
        });

        await session.start();

        for (const name of PRODUCTION_HANDLERS) {
            await session.handleEvent({
                kind: 'chat_message',
                messageId: `gate-${name}`,
                broadcasterTwitchId: '4242',
                chatter: {
                    twitchUserId: 'gate-caller', login: 'gatecaller', displayName: 'GateCaller',
                    isModerator: true, isVip: false, isSubscriber: false, isBroadcaster: true
                },
                text: `!gate-${name}`
            });
        }

        await session.stop();

        expect(unknown).toEqual([]);
    });
});

/** One command row per handler name, so each is actually dispatched. */
function buildRepositories(handle: DbHandle, channelId: string, handlers: string[]): unknown {
    return {
        commands: {
            listAll: async () => handlers.map((handlerName) => ({
                name: `!gate-${handlerName}`, responseText: null, handlerName,
                description: null, userLevel: 'everyone'
            })),
            updateUserLevel: async () => undefined,
            updateDescription: async () => undefined,
            create: async () => undefined,
            updateResponse: async () => false,
            delete: async () => false
        },
        emotes: { listAll: async () => [] },
        settings: {
            get: async () => ({
                aiEnabled: true,
                aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 },
                songRequestsEnabled: true, discordWebhookUrl: null,
                requestsPlaylistEnabled: false, requestsPlaylistName: null, requestsPlaylistId: null
            })
        },
        roles: {
            upsertRoles: async () => undefined,
            get: async () => null,
            findByLogin: async () => null,
            followedAt: async () => null
        },
        quotes: new QuoteRepository(handle.db, channelId),
        history: undefined
    };
}
