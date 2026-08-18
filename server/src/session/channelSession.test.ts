import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import type { TransportEvent, LiveEvent, LiveChannelStatus } from '@almosthadai/shared';
import { ChannelSession } from './channelSession.js';
import { SessionManager } from './sessionManager.js';
import { FakeTransport } from '../transport/fakeTransport.js';
import type { ChatPipeline } from './chatPipeline.js';
import type { CommandManager } from '../domain/commandManager.js';
import type { EmoteManager } from '../domain/emoteManager.js';
import type { EventBus } from '../live/eventBus.js';

/**
 * Lifecycle discipline. Start and stop are idempotent, teardown completes
 * through a failing step, and dedup survives the whole session.
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
// carries, so the fixture supplies one rather than a synthetic shape the
// normalizer could never produce.
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
            // A half-started session masquerading as healthy is the failure
            // this guards against.
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

/**
 * The status the dashboard renders.
 *
 * The client ticks its uptime clock locally and re-syncs on every one of these,
 * so the load-bearing property is not that an event is published but that
 * `startedAt` is the stream's start, which does not move, rather than the moment
 * of publication, which does.
 */
describe('ChannelSession channel.status', () => {
    const published: LiveEvent[] = [];
    const bus: EventBus = {
        publish: (_channelId, event) => { published.push(event); },
        subscribe: () => () => undefined
    };

    const statuses = (): LiveChannelStatus[] =>
        published.filter((e): e is LiveChannelStatus => e.type === 'channel.status');

    /** A stream service with the one method the session reads, plus liveness. */
    const streamsStub = (startedAt: Date | null) => ({
        load: vi.fn(async () => undefined),
        onOnline: vi.fn(async () => undefined),
        onOffline: vi.fn(async () => undefined),
        startedAt: () => startedAt,
        get isLive() { return startedAt !== null; }
    });

    const makeSession = (streams?: ReturnType<typeof streamsStub>): ChannelSession =>
        new ChannelSession({
            channelId: 'c1',
            broadcasterTwitchId: '1',
            logger,
            pipeline: { handle: vi.fn(async () => ({ action: 'none' as const })) } as never,
            commands: { load: vi.fn(async () => undefined) } as never,
            emotes: { load: vi.fn(async () => undefined) } as never,
            ...(streams ? { streams: streams as never } : {}),
            bus
        });

    beforeEach(() => { published.length = 0; });

    it('announces the session coming up and going down', async () => {
        const session = makeSession();

        await session.start();
        await session.stop();

        expect(statuses().map((s) => s.sessionState)).toEqual(['running', 'stopped']);
    });

    it('reports the stream start time, not the moment it published', async () => {
        // The distinction this whole field exists for: a client seeded from the
        // publication time would restart its clock at every status change and
        // read minutes into an hours-long stream.
        const startedAt = new Date('2026-08-16T18:00:00.000Z');
        const session = makeSession(streamsStub(startedAt));

        await session.start();
        await session.handleEvent(streamOnlineEvent('m1'));

        const live = statuses().at(-1)!;
        expect(live.live).toBe(true);
        expect(live.startedAt).toBe('2026-08-16T18:00:00.000Z');
        expect(live.startedAt).not.toBe(live.at);
    });

    it('publishes AFTER the stream is recorded, so startedAt is never null while live', async () => {
        // Ordering, asserted rather than assumed: announcing first would send a
        // live status with no start time and stall the client's clock until the
        // next transition, which may be hours away.
        let recorded = false;
        const streams = {
            load: vi.fn(async () => undefined),
            onOnline: vi.fn(async () => { recorded = true; }),
            onOffline: vi.fn(async () => undefined),
            startedAt: () => (recorded ? new Date('2026-08-16T18:00:00.000Z') : null),
            get isLive() { return recorded; }
        };
        const session = makeSession(streams as never);

        await session.start();
        await session.handleEvent(streamOnlineEvent('m1'));

        expect(statuses().at(-1)!.startedAt).toBe('2026-08-16T18:00:00.000Z');
    });

    it('clears startedAt when the stream ends', async () => {
        const session = makeSession(streamsStub(new Date('2026-08-16T18:00:00.000Z')));
        await session.start();
        await session.handleEvent(streamOnlineEvent('m1'));

        await session.handleEvent({
            kind: 'stream_offline', messageId: 'm2', broadcasterTwitchId: '1'
        });

        const last = statuses().at(-1)!;
        expect(last.live).toBe(false);
        // Null, not a stale timestamp: a client that kept ticking would show an
        // uptime for a stream that is over.
        expect(last.startedAt).toBeNull();
    });

    it('adopts the stream recovered on start, so a restart mid-stream is not reported offline', async () => {
        // The restart case: `load()` resumes the open stream, and without the
        // session adopting its liveness the dashboard showed OFFLINE with no
        // uptime over a channel that was very much live.
        const session = makeSession(streamsStub(new Date('2026-08-16T18:00:00.000Z')));

        await session.start();

        const first = statuses()[0]!;
        expect(first.live).toBe(true);
        expect(first.startedAt).toBe('2026-08-16T18:00:00.000Z');
    });

    it('costs nothing when nothing is watching', async () => {
        // The default bus goes nowhere; a session with no observers must not
        // need one wired to start.
        const session = new ChannelSession({
            channelId: 'c1', broadcasterTwitchId: '1', logger,
            pipeline: { handle: vi.fn() } as never,
            commands: { load: vi.fn(async () => undefined) } as never,
            emotes: { load: vi.fn(async () => undefined) } as never
        });

        await expect(session.start()).resolves.toBeUndefined();
        expect(published).toHaveLength(0);
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
