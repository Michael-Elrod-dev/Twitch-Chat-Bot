import { desc, eq, sql as raw } from 'drizzle-orm';
import { chatTotals, streams, viewers, channelRoles } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

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
