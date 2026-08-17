import type { TransportEvent, ChatMessageEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { ChatPipeline, PipelineOutcome } from './chatPipeline.js';
import type { CommandManager } from '../domain/commandManager.js';
import type { EmoteManager } from '../domain/emoteManager.js';
import type { RedemptionPipeline } from './redemptionPipeline.js';
import type { PlaybackMonitor } from '../spotify/playbackMonitor.js';
import type { StreamService } from '../domain/streamService.js';
import type { PresenceTracker } from '../domain/presenceTracker.js';
import type { EventBus } from '../live/eventBus.js';
import { NULL_EVENT_BUS } from '../live/eventBus.js';

/** Bounded dedup history. Twitch documents EventSub as at-least-once. */
const MAX_SEEN_MESSAGE_IDS = 1000;

export interface ChannelSessionOptions {
    channelId: string;
    broadcasterTwitchId: string;
    logger: Logger;
    pipeline: ChatPipeline;
    commands: CommandManager;
    emotes: EmoteManager;
    /** Absent means redemptions are acknowledged and ignored. */
    redemptions?: RedemptionPipeline;
    /**
     * The Spotify playback poller.
     *
     * Owned by the session so its lifetime IS the session lifetime: started on
     * start, stopped on stop. A poller outliving its session would keep calling
     * Spotify for a channel the bot no longer serves.
     */
    monitor?: PlaybackMonitor;
    /**
     * Stream lifecycle. Absent means online/offline are logged and forgotten,
     * which is what every channel did before P1-WP4.3.
     */
    streams?: StreamService;
    /**
     * The viewer-presence poll. Session-owned for the same reason the playback
     * monitor is: a poller that outlives its session keeps calling Helix for a
     * channel the bot no longer serves.
     */
    presence?: PresenceTracker;
    /**
     * Where realtime observers listen.
     *
     * Defaults to a bus that goes nowhere, exactly as the chat pipeline's does,
     * so a session with no watchers costs nothing and every existing caller
     * keeps working unchanged.
     */
    bus?: EventBus;
}

export type SessionState = 'stopped' | 'starting' | 'running' | 'stopping';

/**
 * Everything one channel owns. Nothing here is shared with another channel: no
 * static state, no module-level caches, no cross-channel lookups. That is the
 * mechanical basis of tenant isolation.
 *
 * Lifecycle discipline is inherited wholesale from Phase 0: start and stop are
 * idempotent, and teardown completes even when a step throws, because a session
 * left half-stopped is worse than one that never stopped at all.
 */
export class ChannelSession {
    readonly channelId: string;
    readonly broadcasterTwitchId: string;

    private readonly logger: Logger;
    private readonly pipeline: ChatPipeline;
    private readonly commands: CommandManager;
    private readonly emotes: EmoteManager;
    private readonly redemptions: RedemptionPipeline | undefined;
    private readonly monitor: PlaybackMonitor | undefined;
    private readonly streams: StreamService | undefined;
    private readonly presence: PresenceTracker | undefined;
    private readonly bus: EventBus;

    private state: SessionState = 'stopped';
    private live = false;

    /** Insertion-ordered, so the oldest id is always evicted first. */
    private readonly seenMessageIds = new Set<string>();

    constructor(options: ChannelSessionOptions) {
        this.channelId = options.channelId;
        this.broadcasterTwitchId = options.broadcasterTwitchId;
        this.logger = options.logger;
        this.pipeline = options.pipeline;
        this.commands = options.commands;
        this.emotes = options.emotes;
        this.redemptions = options.redemptions;
        this.monitor = options.monitor;
        this.streams = options.streams;
        this.presence = options.presence;
        this.bus = options.bus ?? NULL_EVENT_BUS;
    }

    /**
     * Re-reads this channel's content into the running session.
     *
     * **The API writes to the database; this is what tells the bot.** Both
     * managers keep an in-memory map AND a populated Redis hash, and their
     * lookup treats "hash exists, field absent" as an authoritative miss so an
     * ordinary chat message never pays for a database round trip. That
     * optimisation is correct and load-bearing — and it means a row inserted
     * behind the managers' backs is invisible to them, not briefly but
     * permanently: once the hash expires the fallback consults the in-memory
     * map, which `loaded` marks as already good.
     *
     * So a command created in the app saved fine and never fired in chat. The
     * screens were writing to storage the bot had stopped reading.
     */
    async reloadContent(kind: 'commands' | 'emotes'): Promise<void> {
        if (kind === 'commands') await this.commands.load();
        else await this.emotes.load();

        this.logger.debug({ channelId: this.channelId, kind }, 'Reloaded channel content');
    }

    getState(): SessionState {
        return this.state;
    }

    /**
     * Tells every watcher where this channel stands.
     *
     * Published on each transition the dashboard renders — the session coming
     * up or going down, and the stream starting or ending — because those are
     * precisely the moments the status strip, the header pill and the uptime
     * clock are wrong until told otherwise.
     *
     * `startedAt` is read from the stream service rather than tracked here, so
     * there is one answer to "when did this stream begin" and not two that can
     * disagree. It is null whenever the channel is not live, which is what
     * stops the client ticking a clock for a stream that is over.
     *
     * Cannot throw: the bus swallows listener failures and nothing here is
     * awaited, so a watching desktop app can never delay or break a session
     * transition.
     */
    private publishStatus(): void {
        this.bus.publish(this.channelId, {
            type: 'channel.status',
            channelId: this.channelId,
            at: new Date().toISOString(),
            live: this.live,
            sessionState: this.state,
            startedAt: this.live ? (this.streams?.startedAt()?.toISOString() ?? null) : null
        });
    }

    isLive(): boolean {
        return this.live;
    }

    async start(): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') {
            this.logger.debug({ channelId: this.channelId }, 'Session already started');
            return;
        }

        this.state = 'starting';
        try {
            await this.commands.load();
            await this.emotes.load();

            /*
             * Before the monitor starts and before any event can be handled: a
             * restart mid-stream must resume the stream it was already in, or
             * the AI's rate-limit bucket resets and !uptime reports nothing.
             */
            await this.streams?.load();

            /*
             * Adopt the recovered stream's liveness.
             *
             * `load()` resumes the stream that was open before the restart, but
             * the live flag started false — so without this a restart mid-stream
             * left the session reporting offline until the broadcaster ended the
             * stream, and the dashboard would show OFFLINE with no uptime over a
             * channel that was very much live. The stream service is the one
             * that knows; this just stops the session disagreeing with it.
             */
            this.live = this.streams?.isLive ?? false;

            // Started only once the session is otherwise ready, so a failed
            // load cannot leave a poller running for a session that never came up.
            this.monitor?.start();
            this.presence?.start();

            this.state = 'running';
            this.logger.info({ channelId: this.channelId }, 'Channel session started');
            this.publishStatus();
        } catch (err) {
            // A half-started session must not masquerade as running.
            this.state = 'stopped';
            this.logger.error({ channelId: this.channelId, err: (err as Error).message }, 'Session start failed');
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (this.state === 'stopped' || this.state === 'stopping') {
            this.logger.debug({ channelId: this.channelId }, 'Session already stopped');
            return;
        }

        this.state = 'stopping';

        // Each step isolated: one failure must not abandon the rest of teardown.
        await this.runTeardownStep('stop playback monitor', async () => {
            this.monitor?.stop();
        });
        await this.runTeardownStep('stop presence tracker', async () => {
            this.presence?.stop();
        });
        await this.runTeardownStep('clear dedup history', async () => {
            this.seenMessageIds.clear();
        });
        await this.runTeardownStep('clear live flag', async () => {
            this.live = false;
        });

        this.state = 'stopped';
        this.logger.info({ channelId: this.channelId }, 'Channel session stopped');

        // Announced after the state is final, so a watcher never sees
        // `stopping` as the last word on a session that has fully stopped.
        this.publishStatus();
    }

    private async runTeardownStep(description: string, step: () => Promise<void>): Promise<void> {
        try {
            await step();
        } catch (err) {
            this.logger.error(
                { channelId: this.channelId, step: description, err: (err as Error).message },
                'Teardown step failed'
            );
        }
    }

    /**
     * Routes one event.
     *
     * @returns the pipeline outcome, or null when the event was deduplicated,
     * arrived for another broadcaster, or is not a chat message.
     */
    async handleEvent(event: TransportEvent): Promise<PipelineOutcome | null> {
        // A session only ever handles its own broadcaster's events. Belt and
        // braces alongside SessionManager's routing.
        if (event.broadcasterTwitchId !== this.broadcasterTwitchId) {
            this.logger.warn(
                { channelId: this.channelId, got: event.broadcasterTwitchId },
                'Event routed to the wrong session - ignoring'
            );
            return null;
        }

        if (this.isDuplicate(event.messageId)) {
            this.logger.debug({ channelId: this.channelId, messageId: event.messageId }, 'Dropping duplicate event');
            return null;
        }

        switch (event.kind) {
        case 'stream_online':
            this.live = true;
            // Published AFTER the stream is recorded, never before: the event
            // carries `startedAt`, and the stream service is where that comes
            // from. Announcing first would send a live status with a null start
            // time and stall the client's clock until the next transition.
            await this.streams?.onOnline(event.streamId, new Date(event.startedAt));
            this.publishStatus();
            return null;

        case 'stream_offline':
            this.live = false;
            await this.streams?.onOffline();
            this.publishStatus();
            return null;

        case 'redemption':
            if (this.state !== 'running') {
                this.logger.warn(
                    { channelId: this.channelId, rewardId: event.rewardId },
                    'Dropping redemption for a session that is not running'
                );
                return null;
            }
            // Redemptions cost real channel points, so an unhandled one is a
            // debt rather than a no-op. The pipeline refunds what it cannot do.
            await this.redemptions?.handle(event);
            return null;

        case 'chat_message':
            if (this.state !== 'running') {
                // WARN, not debug. This is a real viewer's message being
                // dropped, and it should be rare by construction: the manager
                // unsubscribes before it stops a session, so the only way here
                // is an event already in the queue when the session stopped.
                // Rare-by-construction is exactly what must be visible when it
                // stops being rare - at debug, production would never show it.
                this.logger.warn(
                    { channelId: this.channelId, state: this.state },
                    'Dropping chat for a session that is not running'
                );
                return null;
            }
            return this.pipeline.handle(event satisfies ChatMessageEvent);
        }
    }

    /** Records an id and reports whether it had already been seen. */
    private isDuplicate(messageId: string): boolean {
        if (!messageId) return false;

        if (this.seenMessageIds.has(messageId)) return true;

        this.seenMessageIds.add(messageId);
        if (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
            const oldest = this.seenMessageIds.values().next().value;
            if (oldest !== undefined) this.seenMessageIds.delete(oldest);
        }
        return false;
    }
}
