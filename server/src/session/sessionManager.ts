import type { TransportEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { Transport } from '../transport/types.js';
import type { ChannelSession } from './channelSession.js';

export interface SessionManagerOptions {
    transport: Transport;
    logger: Logger;
}

/**
 * Owns the set of live channel sessions and routes events to the right one.
 *
 * Routing is by `broadcasterTwitchId`, and a session that receives an event for
 * another broadcaster rejects it - two independent checks, because a routing bug
 * here would be a cross-tenant data leak rather than a mere malfunction.
 */
export class SessionManager {
    private readonly transport: Transport;
    private readonly logger: Logger;

    private readonly byChannelId = new Map<string, ChannelSession>();
    private readonly byBroadcasterId = new Map<string, ChannelSession>();
    private started = false;

    constructor(options: SessionManagerOptions) {
        this.transport = options.transport;
        this.logger = options.logger;
    }

    get size(): number {
        return this.byChannelId.size;
    }

    /** Begins delivering transport events into sessions. Idempotent. */
    async start(): Promise<void> {
        if (this.started) return;
        await this.transport.start((event) => this.route(event));
        this.started = true;
        this.logger.info({ transport: this.transport.name }, 'Session manager started');
    }

    async add(session: ChannelSession): Promise<void> {
        if (this.byChannelId.has(session.channelId)) {
            this.logger.debug({ channelId: session.channelId }, 'Session already registered');
            return;
        }

        await session.start();
        this.byChannelId.set(session.channelId, session);
        this.byBroadcasterId.set(session.broadcasterTwitchId, session);
        await this.transport.subscribe(session.broadcasterTwitchId);

        this.logger.info({ channelId: session.channelId }, 'Channel session registered');
    }

    async remove(channelId: string): Promise<void> {
        const session = this.byChannelId.get(channelId);
        if (!session) return;

        // Unsubscribe first so no further events arrive for a stopping session.
        await this.transport.unsubscribe(session.broadcasterTwitchId);
        await session.stop();

        this.byChannelId.delete(channelId);
        this.byBroadcasterId.delete(session.broadcasterTwitchId);
        this.logger.info({ channelId }, 'Channel session removed');
    }

    get(channelId: string): ChannelSession | undefined {
        return this.byChannelId.get(channelId);
    }

    /** Stops every session. One failure must not strand the others. */
    async stopAll(): Promise<void> {
        for (const channelId of [...this.byChannelId.keys()]) {
            try {
                await this.remove(channelId);
            } catch (err) {
                this.logger.error(
                    { channelId, err: (err as Error).message },
                    'Failed to stop session - continuing with the rest'
                );
            }
        }

        await this.transport.stop();
        this.started = false;
    }

    private async route(event: TransportEvent): Promise<void> {
        const session = this.byBroadcasterId.get(event.broadcasterTwitchId);
        if (!session) {
            this.logger.warn(
                { broadcasterTwitchId: event.broadcasterTwitchId },
                'Event for an unknown broadcaster - dropping'
            );
            return;
        }

        try {
            await session.handleEvent(event);
        } catch (err) {
            // One channel's failure must never take down the shared loop.
            this.logger.error(
                { channelId: session.channelId, err: (err as Error).message },
                'Session failed to handle event'
            );
        }
    }
}
