import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import type { TransportEvent } from '@almosthadai/shared';
import { ChannelSession } from './channelSession.js';
import { SessionManager } from './sessionManager.js';
import { FakeTransport } from '../transport/fakeTransport.js';
import type { ChatPipeline } from './chatPipeline.js';
import type { CommandManager } from '../domain/commandManager.js';
import type { EmoteManager } from '../domain/emoteManager.js';

/**
 * Lifecycle discipline ported from Phase 0 tests/bot/bot.lifecycle.test.js and
 * bot.teardown.test.js — idempotent start/stop, teardown that completes through a
 * failing step, and dedup that survives the whole session.
 */

const logger = pino({ level: 'silent' });

const chatEvent = (id: string, broadcasterTwitchId = '1'): TransportEvent => ({
    kind: 'chat_message',
    messageId: id,
    broadcasterTwitchId,
    chatter: {
        twitchUserId: 'u', login: 'v', displayName: 'V',
        isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
    },
    text: 'hi'
});

// `streamId` is Twitch's own stream id, which every real stream.online payload
// carries — the fixture supplies one rather than a synthetic shape the
// normaliser could never produce.
const streamOnlineEvent = (id: string, streamId = '48765430'): TransportEvent => ({
    kind: 'stream_online',
    messageId: id,
    broadcasterTwitchId: '1',
    streamId,
    startedAt: '2026-08-16T18:00:00Z'
});

describe('ChannelSession', () => {
    let pipeline: ChatPipeline & { handle: ReturnType<typeof vi.fn> };
    let commands: CommandManager & { load: ReturnType<typeof vi.fn> };
    let emotes: EmoteManager & { load: ReturnType<typeof vi.fn> };
    let session: ChannelSession;

    beforeEach(() => {
        pipeline = { handle: vi.fn(async () => ({ action: 'none' as const })) } as never;
        commands = { load: vi.fn(async () => undefined) } as never;
        emotes = { load: vi.fn(async () => undefined) } as never;

        session = new ChannelSession({
            channelId: 'c1', broadcasterTwitchId: '1', logger, pipeline, commands, emotes
        });
    });

    describe('start', () => {
        it('loads the channel content and reports running', async () => {
            await session.start();

            expect(commands.load).toHaveBeenCalled();
            expect(emotes.load).toHaveBeenCalled();
            expect(session.getState()).toBe('running');
        });

        it('is idempotent', async () => {
            await session.start();
            await session.start();

            expect(commands.load).toHaveBeenCalledTimes(1);
        });

        it('does NOT report running when startup fails', async () => {
            // A half-started session masquerading as healthy is the Phase-0
            // failure this guards against.
            commands.load.mockRejectedValue(new Error('DB down'));

            await expect(session.start()).rejects.toThrow('DB down');
            expect(session.getState()).toBe('stopped');
        });
    });

    describe('stop', () => {
        it('reports stopped', async () => {
            await session.start();
            await session.stop();

            expect(session.getState()).toBe('stopped');
        });

        it('is idempotent', async () => {
            await session.start();
            await session.stop();

            await expect(session.stop()).resolves.toBeUndefined();
        });

        it('is safe on a session that never started', async () => {
            await expect(session.stop()).resolves.toBeUndefined();
        });

        it('clears the live flag', async () => {
            await session.start();
            await session.handleEvent(streamOnlineEvent('o1'));
            expect(session.isLive()).toBe(true);

            await session.stop();
            expect(session.isLive()).toBe(false);
        });
    });

    describe('event handling', () => {
        beforeEach(async () => {
            await session.start();
        });

        it('routes chat to the pipeline', async () => {
            await session.handleEvent(chatEvent('m1'));

            expect(pipeline.handle).toHaveBeenCalled();
        });

        it('ignores chat while not running', async () => {
            await session.stop();
            const result = await session.handleEvent(chatEvent('m1'));

            expect(result).toBeNull();
            expect(pipeline.handle).not.toHaveBeenCalled();
        });

        it('tracks stream online and offline', async () => {
            await session.handleEvent(streamOnlineEvent('o'));
            expect(session.isLive()).toBe(true);

            await session.handleEvent({ kind: 'stream_offline', messageId: 'f', broadcasterTwitchId: '1' });
            expect(session.isLive()).toBe(false);
        });

        it('rejects an event for another broadcaster', async () => {
            const result = await session.handleEvent(chatEvent('m1', '999'));

            expect(result).toBeNull();
            expect(pipeline.handle).not.toHaveBeenCalled();
        });
    });

    describe('deduplication', () => {
        beforeEach(async () => {
            await session.start();
        });

        it('drops a redelivered message', async () => {
            // Twitch documents EventSub as at-least-once.
            await session.handleEvent(chatEvent('same'));
            await session.handleEvent(chatEvent('same'));

            expect(pipeline.handle).toHaveBeenCalledTimes(1);
        });

        it('dedups across event kinds, not just chat', async () => {
            await session.handleEvent(streamOnlineEvent('x'));
            await session.handleEvent(streamOnlineEvent('x'));

            expect(session.isLive()).toBe(true);
        });

        it('processes distinct ids', async () => {
            await session.handleEvent(chatEvent('a'));
            await session.handleEvent(chatEvent('b'));

            expect(pipeline.handle).toHaveBeenCalledTimes(2);
        });

        it('bounds the history', async () => {
            for (let i = 0; i < 1100; i++) {
                await session.handleEvent(chatEvent(`id-${i}`));
            }

            // The earliest id has been evicted, so it is processed again rather
            // than growing the set forever.
            await session.handleEvent(chatEvent('id-0'));
            expect(pipeline.handle).toHaveBeenCalledTimes(1101);
        });

        it('forgets history on stop', async () => {
            await session.handleEvent(chatEvent('same'));
            await session.stop();
            await session.start();
            await session.handleEvent(chatEvent('same'));

            expect(pipeline.handle).toHaveBeenCalledTimes(2);
        });
    });
});

describe('SessionManager', () => {
    let transport: FakeTransport;
    let manager: SessionManager;

    const makeSession = (channelId: string, broadcasterTwitchId: string): ChannelSession =>
        new ChannelSession({
            channelId, broadcasterTwitchId, logger,
            pipeline: { handle: vi.fn(async () => ({ action: 'none' as const })) } as never,
            commands: { load: vi.fn(async () => undefined) } as never,
            emotes: { load: vi.fn(async () => undefined) } as never
        });

    beforeEach(async () => {
        transport = new FakeTransport();
        manager = new SessionManager({ transport, logger });
        await manager.start();
    });

    it('starts the transport once', async () => {
        await manager.start();
        expect(transport.isStarted).toBe(true);
    });

    it('registers and subscribes a session', async () => {
        await manager.add(makeSession('c1', '1'));

        expect(manager.size).toBe(1);
        expect(transport.subscribed.has('1')).toBe(true);
    });

    it('ignores a duplicate registration', async () => {
        await manager.add(makeSession('c1', '1'));
        await manager.add(makeSession('c1', '1'));

        expect(manager.size).toBe(1);
    });

    it('unsubscribes before stopping, so no event races teardown', async () => {
        const session = makeSession('c1', '1');
        await manager.add(session);
        const stopSpy = vi.spyOn(session, 'stop');
        const unsubSpy = vi.spyOn(transport, 'unsubscribe');

        await manager.remove('c1');

        expect(unsubSpy.mock.invocationCallOrder[0]!).toBeLessThan(stopSpy.mock.invocationCallOrder[0]!);
    });

    it('removing an unknown channel is a no-op', async () => {
        await expect(manager.remove('nope')).resolves.toBeUndefined();
    });

    it('stops every session and the transport', async () => {
        await manager.add(makeSession('c1', '1'));
        await manager.add(makeSession('c2', '2'));

        await manager.stopAll();

        expect(manager.size).toBe(0);
        expect(transport.isStarted).toBe(false);
    });

    it('keeps stopping the rest when one session fails to stop', async () => {
        const bad = makeSession('bad', '1');
        vi.spyOn(bad, 'stop').mockRejectedValue(new Error('stuck'));
        await manager.add(bad);
        await manager.add(makeSession('good', '2'));

        await manager.stopAll();

        expect(manager.get('good')).toBeUndefined();
    });
});
