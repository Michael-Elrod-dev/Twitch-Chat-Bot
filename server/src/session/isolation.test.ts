import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import type { ChatMessageEvent, ChatterIdentity } from '@almosthadai/shared';
import { FakeTransport } from '../transport/fakeTransport.js';
import { SessionManager } from './sessionManager.js';
import { ChannelSession } from './channelSession.js';
import { ChatPipeline } from './chatPipeline.js';
import { CommandManager } from '../domain/commandManager.js';
import { EmoteManager } from '../domain/emoteManager.js';
import { SettingsService } from '../domain/settings.js';
import { StubAiService } from '../services/aiService.js';
import { NoopAnalyticsSink } from '../services/analytics.js';
import type { CacheManager } from '../cache/cacheManager.js';
import type { CommandRecord, CommandRepository } from '../db/repositories/commandRepository.js';
import type { EmoteRecord, EmoteRepository } from '../db/repositories/emoteRepository.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { ChannelSettingsRepository } from '../db/repositories/channelSettingsRepository.js';

/**
 * THE CENTREPIECE: two channels running concurrently in one process, proving
 * that nothing leaks between them.
 *
 * Every Phase-0 subsystem was single-tenant. The single most expensive mistake
 * this architecture could make is for channel A's configuration, permissions, or
 * state to influence channel B — so it gets its own file and its own scrutiny.
 */

const logger = pino({ level: 'silent' });
const BOT_ID = 'bot-999';

/** A cache that never serves anything, so every lookup exercises the real path. */
const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const chatter = (overrides: Partial<ChatterIdentity> = {}): ChatterIdentity => ({
    twitchUserId: 'u-1',
    login: 'viewer',
    displayName: 'Viewer',
    isModerator: false,
    isVip: false,
    isSubscriber: false,
    isBroadcaster: false,
    ...overrides
});

let messageCounter = 0;
const chatEvent = (broadcasterTwitchId: string, text: string, who = chatter()): ChatMessageEvent => ({
    kind: 'chat_message',
    messageId: `msg-${++messageCounter}`,
    broadcasterTwitchId,
    chatter: who,
    text
});

interface Harness {
    session: ChannelSession;
    sent: string[];
    ai: StubAiService;
    analytics: NoopAnalyticsSink;
    settings: SettingsService;
}

/** Builds one fully-wired channel with its own isolated dependencies. */
function buildChannel(opts: {
    channelId: string;
    broadcasterTwitchId: string;
    commands: CommandRecord[];
    emotes: EmoteRecord[];
    aiEnabled?: boolean;
}): Harness {
    const sent: string[] = [];
    const cache = nullCache();

    const commandRepo = {
        listAll: async () => opts.commands,
        create: vi.fn(), updateResponse: vi.fn(), updateUserLevel: vi.fn(), delete: vi.fn()
    } as unknown as CommandRepository;

    const emoteRepo = {
        listAll: async () => opts.emotes,
        create: vi.fn(), delete: vi.fn()
    } as unknown as EmoteRepository;

    const settingsRepo = {
        get: async () => ({
            aiEnabled: opts.aiEnabled ?? true,
            songRequestsEnabled: true,
            discordWebhookUrl: null
        }),
        setAiEnabled: vi.fn()
    } as unknown as ChannelSettingsRepository;

    const roleRepo = {
        get: async () => null,
        upsertRoles: vi.fn(async () => undefined),
        touchPresence: vi.fn(async () => undefined)
    } as unknown as ChannelRoleRepository;

    const commands = new CommandManager({ channelId: opts.channelId, repository: commandRepo, cache, logger });
    const emotes = new EmoteManager({ channelId: opts.channelId, repository: emoteRepo, cache });
    const settings = new SettingsService({ channelId: opts.channelId, repository: settingsRepo, cache, logger });
    const ai = new StubAiService();
    const analytics = new NoopAnalyticsSink();

    const pipeline = new ChatPipeline({
        channelId: opts.channelId,
        botTwitchUserId: BOT_ID,
        aiTriggers: ['almosthadai'],
        commands, emotes, settings, roles: roleRepo, ai, analytics, logger,
        sendMessage: async (text: string) => { sent.push(text); }
    });

    const session = new ChannelSession({
        channelId: opts.channelId,
        broadcasterTwitchId: opts.broadcasterTwitchId,
        logger, pipeline, commands, emotes
    });

    return { session, sent, ai, analytics, settings };
}

describe('two channels, one process', () => {
    let transport: FakeTransport;
    let manager: SessionManager;
    let alpha: Harness;
    let beta: Harness;

    beforeEach(async () => {
        transport = new FakeTransport();
        manager = new SessionManager({ transport, logger });

        // Deliberately overlapping names with different meanings - the exact
        // situation that a single-tenant assumption would get wrong.
        alpha = buildChannel({
            channelId: 'channel-alpha',
            broadcasterTwitchId: '1001',
            commands: [
                { name: '!discord', responseText: 'ALPHA discord link', handlerName: null, description: null, userLevel: 'everyone' },
                { name: '!alphaonly', responseText: 'alpha secret', handlerName: null, description: null, userLevel: 'everyone' }
            ],
            emotes: [{ triggerText: 'hello', responseText: 'ALPHA waves' }]
        });

        beta = buildChannel({
            channelId: 'channel-beta',
            broadcasterTwitchId: '2002',
            commands: [
                { name: '!discord', responseText: 'BETA discord link', handlerName: null, description: null, userLevel: 'everyone' },
                { name: '!betaonly', responseText: 'beta secret', handlerName: null, description: null, userLevel: 'mod' }
            ],
            emotes: [{ triggerText: 'hello', responseText: 'BETA nods' }]
        });

        await manager.start();
        await manager.add(alpha.session);
        await manager.add(beta.session);
    });

    describe('content isolation', () => {
        it('answers the same command name differently per channel', async () => {
            await transport.emit(chatEvent('1001', '!discord'));
            await transport.emit(chatEvent('2002', '!discord'));

            expect(alpha.sent).toEqual(['ALPHA discord link']);
            expect(beta.sent).toEqual(['BETA discord link']);
        });

        it('does not run channel A commands in channel B', async () => {
            await transport.emit(chatEvent('2002', '!alphaonly'));

            expect(beta.sent).toEqual([]);
            expect(alpha.sent).toEqual([]);
        });

        it('does not run channel B commands in channel A', async () => {
            await transport.emit(chatEvent('1001', '!betaonly', chatter({ isModerator: true })));

            expect(alpha.sent).toEqual([]);
        });

        it('matches the same emote trigger differently per channel', async () => {
            await transport.emit(chatEvent('1001', 'hello'));
            await transport.emit(chatEvent('2002', 'hello'));

            expect(alpha.sent).toEqual(['ALPHA waves']);
            expect(beta.sent).toEqual(['BETA nods']);
        });
    });

    describe('permission isolation', () => {
        it('applies each channel own level for its own command', async () => {
            // !betaonly is mod-level in beta. The same user is a plain viewer.
            await transport.emit(chatEvent('2002', '!betaonly'));
            expect(beta.sent).toEqual([]);

            await transport.emit(chatEvent('2002', '!betaonly', chatter({ isModerator: true })));
            expect(beta.sent).toEqual(['beta secret']);
        });

        it('does not carry a moderator role across channels', async () => {
            // Roles arrive per-event from the channel the message was sent in, so
            // being a mod in beta cannot grant anything in alpha.
            const modInBeta = chatter({ twitchUserId: 'shared-user', isModerator: true });
            await transport.emit(chatEvent('2002', '!betaonly', modInBeta));
            expect(beta.sent).toEqual(['beta secret']);

            const sameUserInAlpha = chatter({ twitchUserId: 'shared-user', isModerator: false });
            await transport.emit(chatEvent('1001', '!betaonly', sameUserInAlpha));
            expect(alpha.sent).toEqual([]);
        });
    });

    describe('settings isolation', () => {
        it('lets one channel disable AI without affecting the other', async () => {
            const quiet = buildChannel({
                channelId: 'channel-quiet', broadcasterTwitchId: '3003',
                commands: [], emotes: [], aiEnabled: false
            });
            await manager.add(quiet.session);

            await transport.emit(chatEvent('3003', 'hey almosthadai'));
            await transport.emit(chatEvent('1001', 'hey almosthadai'));

            expect(quiet.ai.requests).toHaveLength(0);
            expect(alpha.ai.requests).toHaveLength(1);
        });
    });

    describe('event routing', () => {
        it('drops an event for an unknown broadcaster', async () => {
            await transport.emit(chatEvent('9999', '!discord'));

            expect(alpha.sent).toEqual([]);
            expect(beta.sent).toEqual([]);
        });

        it('subscribes the transport to each broadcaster', () => {
            expect([...transport.subscribed].sort()).toEqual(['1001', '2002']);
        });

        it('records analytics against the right channel only', async () => {
            await transport.emit(chatEvent('1001', 'just chatting'));

            expect(alpha.analytics.recorded).toHaveLength(1);
            expect(alpha.analytics.recorded[0]?.channelId).toBe('channel-alpha');
            expect(beta.analytics.recorded).toHaveLength(0);
        });

        it('keeps dedup histories separate', async () => {
            // Two channels can legitimately see the same message id; one must not
            // suppress the other's event.
            const shared = 'duplicate-id';
            await transport.emit({ ...chatEvent('1001', '!discord'), messageId: shared });
            await transport.emit({ ...chatEvent('2002', '!discord'), messageId: shared });

            expect(alpha.sent).toEqual(['ALPHA discord link']);
            expect(beta.sent).toEqual(['BETA discord link']);
        });

        it('still deduplicates within one channel', async () => {
            const shared = 'same-id';
            await transport.emit({ ...chatEvent('1001', '!discord'), messageId: shared });
            await transport.emit({ ...chatEvent('1001', '!discord'), messageId: shared });

            expect(alpha.sent).toEqual(['ALPHA discord link']);
        });
    });

    describe('failure isolation', () => {
        it('keeps one channel working when another throws', async () => {
            vi.spyOn(beta.session, 'handleEvent').mockRejectedValue(new Error('beta exploded'));

            await transport.emit(chatEvent('2002', '!discord'));
            await transport.emit(chatEvent('1001', '!discord'));

            // A shared event loop must not let one tenant take down another.
            expect(alpha.sent).toEqual(['ALPHA discord link']);
        });

        it('leaves the other channel running when one is removed', async () => {
            await manager.remove('channel-beta');

            await transport.emit(chatEvent('1001', '!discord'));
            await transport.emit(chatEvent('2002', '!discord'));

            expect(alpha.sent).toEqual(['ALPHA discord link']);
            expect(beta.sent).toEqual([]);
            expect(transport.subscribed.has('2002')).toBe(false);
        });
    });

    describe('concurrent traffic', () => {
        it('keeps responses correct when both channels are busy at once', async () => {
            const events = [];
            for (let i = 0; i < 20; i++) {
                events.push(transport.emit(chatEvent('1001', '!discord')));
                events.push(transport.emit(chatEvent('2002', '!discord')));
            }
            await Promise.all(events);

            expect(alpha.sent).toHaveLength(20);
            expect(beta.sent).toHaveLength(20);
            expect(new Set(alpha.sent)).toEqual(new Set(['ALPHA discord link']));
            expect(new Set(beta.sent)).toEqual(new Set(['BETA discord link']));
        });
    });
});
