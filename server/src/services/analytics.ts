import type { ChatMessageEvent } from '@almosthadai/shared';

export type InteractionType = 'message' | 'command' | 'redemption';

/** The seam the analytics pipeline drops into (P1-WP4.3). */
export interface AnalyticsSink {
    recordInteraction: (
        channelId: string,
        event: ChatMessageEvent,
        type: InteractionType
    ) => Promise<void>;
}

/** Records calls, writes nothing. */
export class NoopAnalyticsSink implements AnalyticsSink {
    readonly recorded: { channelId: string; messageId: string; type: InteractionType }[] = [];

    async recordInteraction(
        channelId: string,
        event: ChatMessageEvent,
        type: InteractionType
    ): Promise<void> {
        this.recorded.push({ channelId, messageId: event.messageId, type });
    }
}
