import { desc, eq, sql as raw } from 'drizzle-orm';
import { chatTotals, streams, viewers, channelRoles } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { InteractionType } from '../../services/analytics.js';

export interface AnalyticsSummaryRecord {
    viewers: number;
    messages: number;
    commandsUsed: number;
    streams: number;
    lastStreamAt: string | null;
    topChatters: { login: string; messageCount: number }[];
}

const TOP_CHATTERS = 10;

/**
 * Read-only aggregates for the dashboard.
 *
 * Every query is written to be correct over an empty dataset, because that is
 * the state every newly-onboarded channel is in and a summary endpoint that
 * throws on a new tenant would be worse than one that reports zeroes. Postgres
 * returns NULL rather than 0 for `sum()` over no rows, hence the coalesces.
 */
export class AnalyticsRepository extends ChannelScopedRepository {
    /**
     * Rolls one interaction into the channel's per-viewer totals.
     *
     * **Written synchronously, on purpose.** Phase 0 pushed every interaction
     * through a Redis queue and a consumer process, which bought batching at
     * the price of a second moving part that could fall behind or lose the
     * queue's contents. At two channels the write is one upsert on a two-column
     * primary key; the queue would cost more than it saves.
     *
     * The batching architecture is the recorded scale path, not a rejected
     * idea: when a channel's message rate makes one upsert per message
     * measurable, the seam to change is this method, and nothing above it.
     */
    async recordInteraction(twitchUserId: string, type: InteractionType): Promise<void> {
        const isMessage = type === 'message' ? 1 : 0;
        const isCommand = type === 'command' ? 1 : 0;
        const isRedemption = type === 'redemption' ? 1 : 0;

        await this.db
            .insert(chatTotals)
            .values({
                channelId: this.channelId,
                twitchUserId,
                messageCount: isMessage,
                commandCount: isCommand,
                redemptionCount: isRedemption,
                totalCount: 1
            })
            .onConflictDoUpdate({
                target: [chatTotals.channelId, chatTotals.twitchUserId],
                // Incremented in SQL rather than read-modify-write: two messages
                // landing together must both count.
                set: {
                    messageCount: raw`${chatTotals.messageCount} + ${isMessage}`,
                    commandCount: raw`${chatTotals.commandCount} + ${isCommand}`,
                    redemptionCount: raw`${chatTotals.redemptionCount} + ${isRedemption}`,
                    totalCount: raw`${chatTotals.totalCount} + 1`,
                    lastUpdatedAt: new Date()
                }
            });
    }

    async summary(): Promise<AnalyticsSummaryRecord> {
        const [totals] = await this.db
            .select({
                messages: raw<number>`coalesce(sum(${chatTotals.messageCount}), 0)::int`,
                commands: raw<number>`coalesce(sum(${chatTotals.commandCount}), 0)::int`
            })
            .from(chatTotals)
            .where(eq(chatTotals.channelId, this.channelId));

        const [viewerCount] = await this.db
            .select({ count: raw<number>`count(*)::int` })
            .from(channelRoles)
            .where(eq(channelRoles.channelId, this.channelId));

        const [streamStats] = await this.db
            .select({
                count: raw<number>`count(*)::int`,
                last: raw<Date | null>`max(${streams.startedAt})`
            })
            .from(streams)
            .where(eq(streams.channelId, this.channelId));

        const top = await this.db
            .select({ login: viewers.login, messageCount: chatTotals.messageCount })
            .from(chatTotals)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatTotals.twitchUserId))
            .where(eq(chatTotals.channelId, this.channelId))
            .orderBy(desc(chatTotals.messageCount))
            .limit(TOP_CHATTERS);

        return {
            viewers: viewerCount?.count ?? 0,
            messages: totals?.messages ?? 0,
            commandsUsed: totals?.commands ?? 0,
            streams: streamStats?.count ?? 0,
            lastStreamAt: streamStats?.last ? new Date(streamStats.last).toISOString() : null,
            topChatters: top.map((t) => ({ login: t.login, messageCount: t.messageCount }))
        };
    }
}
