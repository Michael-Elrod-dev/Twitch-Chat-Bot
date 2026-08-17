import type { AnalyticsRepository } from '../db/repositories/analyticsRepository.js';
import type { StreamRepository } from '../db/repositories/streamRepository.js';

export type InteractionType = 'message' | 'command' | 'redemption';

/**
 * The two things an interaction has to carry to be counted.
 *
 * Narrower than `ChatMessageEvent`, which it is structurally satisfied by, for
 * two reasons. Redemptions are interactions too and are not chat messages —
 * they have a redeemer, not a chatter, and no text the sink has any use for.
 * And a bookkeeping sink that took the whole event could read the message body;
 * asking only for what it counts means it cannot.
 */
export interface InteractionSubject {
    messageId: string;
    chatter: { twitchUserId: string };
}

/** The seam the analytics pipeline drops into (P1-WP4.3). */
export interface AnalyticsSink {
    recordInteraction: (
        channelId: string,
        event: InteractionSubject,
        type: InteractionType
    ) => Promise<void>;
}

/**
 * The real sink: per-viewer totals plus the stream's message count.
 *
 * Deliberately not transactional across the two writes. They are independent
 * aggregates, and a failure between them costs one message of drift in a
 * counter — whereas a transaction here would put chat-path latency behind two
 * table locks for bookkeeping nobody reads in real time.
 */
export class DatabaseAnalyticsSink implements AnalyticsSink {
    private readonly options: {
        analytics: AnalyticsRepository;
        streams?: StreamRepository;
        currentStreamId?: () => string | null;
    };

    constructor(options: {
        analytics: AnalyticsRepository;
        streams?: StreamRepository;
        currentStreamId?: () => string | null;
    }) {
        this.options = options;
    }

    async recordInteraction(
        _channelId: string,
        event: InteractionSubject,
        type: InteractionType
    ): Promise<void> {
        await this.options.analytics.recordInteraction(event.chatter.twitchUserId, type);

        // Per-stream totals only while a stream is running; an offline message
        // belongs to the viewer's lifetime totals and to no stream.
        //
        // Redemptions are excluded from the stream's MESSAGE counter on purpose:
        // spending channel points is an interaction, and it belongs in the
        // viewer's totals, but it is not a line of chat and counting it as one
        // would inflate "messages this stream" by every reward redeemed.
        const streamId = type === 'redemption' ? null : this.options.currentStreamId?.() ?? null;
        if (streamId && this.options.streams) {
            await this.options.streams.recordMessage(streamId);
        }
    }
}

/** Records calls, writes nothing. */
export class NoopAnalyticsSink implements AnalyticsSink {
    readonly recorded: { channelId: string; messageId: string; type: InteractionType }[] = [];

    async recordInteraction(
        channelId: string,
        event: InteractionSubject,
        type: InteractionType
    ): Promise<void> {
        this.recorded.push({ channelId, messageId: event.messageId, type });
    }
}
