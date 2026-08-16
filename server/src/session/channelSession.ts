import type { TransportEvent, ChatMessageEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { ChatPipeline, PipelineOutcome } from './chatPipeline.js';
import type { CommandManager } from '../domain/commandManager.js';
import type { EmoteManager } from '../domain/emoteManager.js';
import type { RedemptionPipeline } from './redemptionPipeline.js';
import type { PlaybackMonitor } from '../spotify/playbackMonitor.js';

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
    }

    getState(): SessionState {
        return this.state;
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

            // Started only once the session is otherwise ready, so a failed
            // load cannot leave a poller running for a session that never came up.
            this.monitor?.start();

            this.state = 'running';
            this.logger.info({ channelId: this.channelId }, 'Channel session started');
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
        await this.runTeardownStep('clear dedup history', async () => {
            this.seenMessageIds.clear();
        });
        await this.runTeardownStep('clear live flag', async () => {
            this.live = false;
        });

        this.state = 'stopped';
        this.logger.info({ channelId: this.channelId }, 'Channel session stopped');
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
            this.logger.info({ channelId: this.channelId }, 'Stream online');
            return null;

        case 'stream_offline':
            this.live = false;
            this.logger.info({ channelId: this.channelId }, 'Stream offline');
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
