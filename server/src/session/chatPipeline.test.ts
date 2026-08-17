import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import type { ChatMessageEvent, ChatterIdentity } from '@almosthadai/shared';
import { ChatPipeline } from './chatPipeline.js';
import { CommandManager } from '../domain/commandManager.js';
import { EmoteManager } from '../domain/emoteManager.js';
import { SettingsService } from '../domain/settings.js';
import { StubAiService } from '../services/aiService.js';
import { NoopAnalyticsSink } from '../services/analytics.js';
import type { CacheManager } from '../cache/cacheManager.js';
import type { CommandRepository, CommandRecord } from '../db/repositories/commandRepository.js';
import type { EmoteRepository } from '../db/repositories/emoteRepository.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { ChannelSettingsRepository } from '../db/repositories/channelSettingsRepository.js';

/**
 * Ported behaviours from Phase 0 tests/messages/chatMessageHandler.test.js,
 * tests/ai/aiManager.triggers.test.js and tests/messages/aiEnabledFlag.test.js.
 * The pipeline ordering findings (WP-6 tasks 5 and 6) are the load-bearing ones.
 */

const logger = pino({ level: 'silent' });
const BOT_ID = 'bot-1';

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const chatter = (o: Partial<ChatterIdentity> = {}): ChatterIdentity => ({
    twitchUserId: 'u-1', login: 'viewer', displayName: 'Viewer',
    isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false, ...o
});

let n = 0;
const event = (text: string, o: Partial<ChatMessageEvent> = {}): ChatMessageEvent => ({
    kind: 'chat_message', messageId: `m-${++n}`, broadcasterTwitchId: '1',
    chatter: chatter(), text, ...o
});

describe('ChatPipeline', () => {
    let sent: string[];
    let ai: StubAiService;
    let analytics: NoopAnalyticsSink;
    let roles: ChannelRoleRepository;
    let aiEnabled: boolean;
    let settingsThrows: boolean;

    const build = (commands: CommandRecord[] = [], emotes = [{ triggerText: 'pog', responseText: 'PogChamp!' }]) => {
        sent = [];
        ai = new StubAiService();
        analytics = new NoopAnalyticsSink();
        const cache = nullCache();

        roles = {
            get: async () => null,
            upsertRoles: vi.fn(async () => undefined),
            touchPresence: vi.fn(async () => undefined)
        } as unknown as ChannelRoleRepository;

        const settingsRepo = {
            get: async () => {
                if (settingsThrows) throw new Error('DB down');
                return { aiEnabled, songRequestsEnabled: true, discordWebhookUrl: null };
            },
            setAiEnabled: vi.fn()
        } as unknown as ChannelSettingsRepository;

        return new ChatPipeline({
            channelId: 'c1',
            botTwitchUserId: BOT_ID,
            aiTriggers: ['almosthadai'],
            commands: new CommandManager({
                channelId: 'c1', cache, logger,
                repository: { listAll: async () => commands } as unknown as CommandRepository
            }),
            emotes: new EmoteManager({
                channelId: 'c1', cache,
                repository: { listAll: async () => emotes } as unknown as EmoteRepository
            }),
            settings: new SettingsService({ channelId: 'c1', repository: settingsRepo, cache, logger }),
            roles, ai, analytics, logger,
            sendMessage: async (t: string) => { sent.push(t); }
        });
    };

    beforeEach(() => {
        aiEnabled = true;
        settingsThrows = false;
    });

    describe('skip rules', () => {
        it('ignores the bot own messages', async () => {
            const pipeline = build();
            const outcome = await pipeline.handle(event('!discord', { chatter: chatter({ twitchUserId: BOT_ID }) }));

            expect(outcome).toEqual({ action: 'skipped', reason: 'own_message' });
            expect(sent).toEqual([]);
        });

        it('ignores reward-attached messages', async () => {
            // They arrive again as redemptions; handling both double-counts.
            const pipeline = build();
            const outcome = await pipeline.handle(event('hello', { rewardId: 'reward-1' }));

            expect(outcome).toEqual({ action: 'skipped', reason: 'reward_attached' });
        });
    });

    describe('commands beat the AI mention path', () => {
        const commands: CommandRecord[] = [
            { name: '!stats', responseText: 'your stats', handlerName: null, description: null, userLevel: 'everyone' }
        ];

        it('runs a command that happens to name the bot', async () => {
            // Phase 0 WP-6 task 5: this was swallowed by the AI path and burned
            // the sender's rate limit.
            const pipeline = build(commands);
            const outcome = await pipeline.handle(event('!stats almosthadai'));

            expect(outcome).toMatchObject({ action: 'command', command: '!stats', ran: true });
            expect(ai.requests).toHaveLength(0);
            expect(sent).toEqual(['your stats']);
        });

        it('never routes a ! message to AI even when the command is unknown', async () => {
            const pipeline = build(commands);
            const outcome = await pipeline.handle(event('!nope almosthadai'));

            expect(outcome).toMatchObject({ action: 'command', ran: false });
            expect(ai.requests).toHaveLength(0);
        });

        it('still triggers AI on a plain mention', async () => {
            const pipeline = build(commands);
            const outcome = await pipeline.handle(event('hey almosthadai how are you'));

            expect(outcome).toMatchObject({ action: 'ai' });
            expect(ai.requests).toHaveLength(1);
            expect(ai.requests[0]?.prompt).toBe('hey how are you');
        });

        it('does not trigger AI on a bare mention with nothing to answer', async () => {
            const pipeline = build();
            const outcome = await pipeline.handle(event('almosthadai'));

            expect(outcome).toEqual({ action: 'none' });
            expect(ai.requests).toHaveLength(0);
        });

        it('strips an @-prefixed mention', async () => {
            const pipeline = build();
            await pipeline.handle(event('@almosthadai what is up'));

            expect(ai.requests[0]?.prompt).toBe('what is up');
        });
    });

    describe('permission enforcement', () => {
        const commands: CommandRecord[] = [
            { name: '!modonly', responseText: 'secret', handlerName: null, description: null, userLevel: 'mod' }
        ];

        it('gates a mod-level command by the chatter role', async () => {
            const rows: { who: string; roles: Parameters<typeof chatter>[0]; replies: string[] }[] = [
                { who: 'viewer', roles: {}, replies: [] },
                { who: 'mod', roles: { isModerator: true }, replies: ['secret'] },
                { who: 'broadcaster', roles: { isBroadcaster: true }, replies: ['secret'] }
            ];

            for (const row of rows) {
                sent.length = 0;
                const pipeline = build(commands);
                const outcome = await pipeline.handle(event('!modonly', { chatter: chatter(row.roles) }));

                expect(sent, row.who).toEqual(row.replies);
                if (row.replies.length === 0) expect(outcome, row.who).toMatchObject({ ran: false });
            }
        });
    });

    describe('emotes', () => {
        it('fires on an exact trigger regardless of case and never on a partial match', async () => {
            const rows: { text: string; action: 'emote' | 'none'; replies: string[] }[] = [
                { text: 'pog', action: 'emote', replies: ['PogChamp!'] },
                { text: 'POG', action: 'emote', replies: ['PogChamp!'] },
                { text: 'that was pog indeed', action: 'none', replies: [] }
            ];

            for (const row of rows) {
                sent.length = 0;
                const pipeline = build();
                const outcome = await pipeline.handle(event(row.text));

                expect(outcome, row.text).toMatchObject({ action: row.action });
                expect(sent, row.text).toEqual(row.replies);
            }
        });
    });

    describe('AI enabled flag', () => {
        it('does not call AI when disabled', async () => {
            aiEnabled = false;
            const pipeline = build();
            await pipeline.handle(event('hey almosthadai'));

            expect(ai.requests).toHaveLength(0);
        });

        it('fails CLOSED when the flag cannot be read', async () => {
            // A DB outage must not resurrect an AI the broadcaster turned off.
            settingsThrows = true;
            const pipeline = build();
            await pipeline.handle(event('hey almosthadai'));

            expect(ai.requests).toHaveLength(0);
        });
    });

    describe('bookkeeping', () => {
        it('records roles from the chat path, which genuinely knows them', async () => {
            const pipeline = build();
            await pipeline.handle(event('hi', { chatter: chatter({ isVip: true }) }));

            expect(roles.upsertRoles).toHaveBeenCalledWith('u-1', 'viewer',
                expect.objectContaining({ isVip: true }));
        });

        it('classifies a command as a command interaction', async () => {
            const pipeline = build([{ name: '!x', responseText: 'y', handlerName: null, description: null, userLevel: 'everyone' }]);
            await pipeline.handle(event('!x'));

            expect(analytics.recorded[0]?.type).toBe('command');
        });

        it('classifies ordinary chat as a message interaction', async () => {
            const pipeline = build();
            await pipeline.handle(event('just talking'));

            expect(analytics.recorded[0]?.type).toBe('message');
        });

        it('still answers when role bookkeeping fails', async () => {
            const pipeline = build([{ name: '!x', responseText: 'y', handlerName: null, description: null, userLevel: 'everyone' }]);
            (roles.upsertRoles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));

            await pipeline.handle(event('!x'));

            expect(sent).toEqual(['y']);
        });

        it('still answers when the analytics hook fails', async () => {
            const pipeline = build([{ name: '!x', responseText: 'y', handlerName: null, description: null, userLevel: 'everyone' }]);
            vi.spyOn(analytics, 'recordInteraction').mockRejectedValue(new Error('queue down'));

            await pipeline.handle(event('!x'));

            expect(sent).toEqual(['y']);
        });
    });
});
