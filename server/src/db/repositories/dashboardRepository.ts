import { and, eq, sql as raw } from 'drizzle-orm';
import { apiUsage, chatMessages } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import { resolveCurrentStream } from './currentStream.js';

export interface DashboardNumbersRecord {
    messages: number;
    chatters: number;
    aiReplies: number;
    pointsRedeemed: number;
}

export interface DashboardStreamRecord {
    id: string;
    startedAt: Date;
    endedAt: Date | null;
}

/**
 * The dashboard's read model.
 *
 * Reads only. Every figure here comes from rows the bot already writes on its
 * ordinary paths. There is no ledger, no counter table and no new write for
 * this screen to be correct. That constraint is deliberate, because a dashboard
 * is a view, and a view that needs its own bookkeeping is a second source of truth
 * that will eventually disagree with the first.
 *
 * Scoped to ONE stream throughout. The lifetime totals live on
 * `AnalyticsRepository` and answer a different question; mixing them would put
 * "messages this stream" next to a number that includes every previous stream.
 */
export class DashboardRepository extends ChannelScopedRepository {
    /**
     * @returns the open stream, or the most recent finished one, or null.
     *
     * One query for both cases because the dashboard asks the same question in
     * both, which is "which stream are these numbers about". Live shows the
     * open one, and offline falls back to the last, which is exactly what the
     * `Last stream` caption is captioning.
     *
     * The ordering is not written here. It lives in `resolveCurrentStream`
     * because the analytics screen's `this_stream` chip asks the identical
     * question, and two separate orderings differ on a crash-orphaned stream
     * row.
     */
    async currentOrLastStream(): Promise<DashboardStreamRecord | null> {
        return resolveCurrentStream(this.db, this.channelId);
    }

    /**
     * The four figures, for one stream.
     *
     * Three reads rather than one join: the sources are genuinely different
     * tables with different grains, and forcing them into a single statement
     * would multiply rows across the join before aggregating them, which is the
     * classic way to report a chatter count inflated by however many AI replies
     * they triggered.
     */
    async numbersForStream(streamId: string): Promise<DashboardNumbersRecord> {
        /*
         * `count(distinct ...)` over one stream's messages, rather than the
         * `streams.unique_chatters` column, because nothing has ever written
         * that column, so it would report 0 for every stream, which is a lie the
         * screen cannot detect. Costed rather than assumed, the read is covered
         * by `chat_messages_channel_stream_time_idx` (channel, stream, time) and
         * runs once per dashboard load, not per message.
         *
         * `message_type` splits the same rows two ways in one pass: everything
         * that is not a redemption is a chat line the broadcaster typed or a
         * command, and redemptions are the points figure.
         */
        const [chat] = await this.db
            .select({
                messages: raw<number>`count(*) filter (where ${chatMessages.messageType} <> 'redemption')::int`,
                chatters: raw<number>`count(distinct ${chatMessages.twitchUserId}) filter (where ${chatMessages.messageType} <> 'redemption')::int`,
                pointsRedeemed: raw<number>`count(*) filter (where ${chatMessages.messageType} = 'redemption')::int`
            })
            .from(chatMessages)
            .where(and(
                eq(chatMessages.channelId, this.channelId),
                eq(chatMessages.streamId, streamId)
            ));

        // Every AI answer increments a per-viewer counter for the stream, so the
        // stream's total is their sum, not a row count, which would report the
        // number of people who asked rather than the number of replies given.
        const [ai] = await this.db
            .select({ replies: raw<number>`coalesce(sum(${apiUsage.usageCount}), 0)::int` })
            .from(apiUsage)
            .where(and(
                eq(apiUsage.channelId, this.channelId),
                eq(apiUsage.streamId, streamId)
            ));

        return {
            messages: chat?.messages ?? 0,
            chatters: chat?.chatters ?? 0,
            aiReplies: ai?.replies ?? 0,
            pointsRedeemed: chat?.pointsRedeemed ?? 0
        };
    }
}
