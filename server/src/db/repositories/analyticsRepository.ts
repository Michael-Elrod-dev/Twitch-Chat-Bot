import { and, desc, eq, sql as raw, type SQL } from 'drizzle-orm';
import { chatMessages, chatTotals, streams, viewers, channelRoles } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { AnalyticsRange } from '@almosthadai/shared';
import type { InteractionType } from '../../services/analytics.js';

export interface StreamSummaryRecord {
    startedAt: string;
    endedAt: string | null;
    messages: number;
    chatters: number;
}

export interface AnalyticsSummaryRecord {
    range: AnalyticsRange;
    viewers: number;
    messages: number;
    commandsUsed: number;
    streams: number;
    lastStreamAt: string | null;
    topChatters: { login: string; messageCount: number }[];
    recentStreams: StreamSummaryRecord[];
}

const TOP_CHATTERS = 10;

/**
 * How many streams the table shows.
 *
 * A cap, not a page. The screen's footer says how young the data is ("Four
 * streams in. Trends show up around ten."), and a channel that reaches the cap
 * has enough history to want a real paged view — which is a different screen,
 * not a bigger array. Logged as a limit rather than silently truncating: see
 * `recentStreams` returning fewer than `streams` counts.
 */
const RECENT_STREAMS = 20;

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

    /** @returns one viewer's totals in this channel, or null if they have none. */
    async totalsForLogin(login: string): Promise<{
        login: string;
        messageCount: number;
        commandCount: number;
        redemptionCount: number;
        totalCount: number;
    } | null> {
        const [row] = await this.db
            .select({
                login: viewers.login,
                messageCount: chatTotals.messageCount,
                commandCount: chatTotals.commandCount,
                redemptionCount: chatTotals.redemptionCount,
                totalCount: chatTotals.totalCount
            })
            .from(chatTotals)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatTotals.twitchUserId))
            .where(and(
                eq(chatTotals.channelId, this.channelId),
                raw`lower(${viewers.login}) = ${login.toLowerCase()}`
            ))
            .limit(1);

        return row ?? null;
    }

    /**
     * @returns the most active viewers in this channel.
     *
     * Reads `chat_totals`, where Phase 0 read `chat_messages` — it grouped and
     * counted the entire per-message table on every `!topchats`, which grows
     * without bound and which the owner has now deferred pruning on. The
     * aggregate exists precisely so this question costs one indexed read.
     */
    async topChatters(limit: number): Promise<{ login: string; totalCount: number }[]> {
        return this.db
            .select({ login: viewers.login, totalCount: chatTotals.totalCount })
            .from(chatTotals)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatTotals.twitchUserId))
            .where(eq(chatTotals.channelId, this.channelId))
            .orderBy(desc(chatTotals.totalCount))
            .limit(limit);
    }

    /**
     * The analytics screen, for one range.
     *
     * `all_time` reads the lifetime counters the bot maintains per message —
     * two indexed aggregates and no scan of the message table. The other two
     * ranges cannot use those counters at all, because a counter has no time
     * dimension, so they range over `chat_messages` under
     * `chat_messages_channel_stream_time_idx`. That difference in cost is why
     * `all_time` is the default the screen opens on.
     *
     * `this_stream` with no stream — a channel that has never gone live with
     * the bot connected — reports zeroes rather than failing. It is the state
     * every new tenant is in, and the screen renders the real small numbers.
     */
    async summary(range: AnalyticsRange = 'all_time'): Promise<AnalyticsSummaryRecord> {
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

        const windowed = range === 'all_time'
            ? await this.lifetimeTotals()
            : await this.windowedTotals(range);

        return {
            range,
            viewers: viewerCount?.count ?? 0,
            messages: windowed.messages,
            commandsUsed: windowed.commandsUsed,
            streams: streamStats?.count ?? 0,
            lastStreamAt: streamStats?.last ? new Date(streamStats.last).toISOString() : null,
            topChatters: windowed.topChatters,
            recentStreams: await this.recentStreams()
        };
    }

    /** Lifetime, from the counters. */
    private async lifetimeTotals(): Promise<{
        messages: number;
        commandsUsed: number;
        topChatters: { login: string; messageCount: number }[];
    }> {
        const [totals] = await this.db
            .select({
                messages: raw<number>`coalesce(sum(${chatTotals.messageCount}), 0)::int`,
                commands: raw<number>`coalesce(sum(${chatTotals.commandCount}), 0)::int`
            })
            .from(chatTotals)
            .where(eq(chatTotals.channelId, this.channelId));

        const top = await this.db
            .select({ login: viewers.login, messageCount: chatTotals.messageCount })
            .from(chatTotals)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatTotals.twitchUserId))
            .where(eq(chatTotals.channelId, this.channelId))
            .orderBy(desc(chatTotals.messageCount))
            .limit(TOP_CHATTERS);

        return {
            messages: totals?.messages ?? 0,
            commandsUsed: totals?.commands ?? 0,
            topChatters: top.map((t) => ({ login: t.login, messageCount: t.messageCount }))
        };
    }

    /**
     * A bounded window, from the messages themselves.
     *
     * `this_stream` resolves to the most recent stream — the open one while
     * live, the last one when offline, the same rule the dashboard follows so
     * the two screens cannot disagree about which stream "this" is.
     */
    private async windowedTotals(range: Exclude<AnalyticsRange, 'all_time'>): Promise<{
        messages: number;
        commandsUsed: number;
        topChatters: { login: string; messageCount: number }[];
    }> {
        const scope = await this.windowScope(range);
        // A channel with no stream yet: real zeroes, not an error.
        if (!scope) return { messages: 0, commandsUsed: 0, topChatters: [] };

        const [totals] = await this.db
            .select({
                messages: raw<number>`count(*) filter (where ${chatMessages.messageType} = 'message')::int`,
                commands: raw<number>`count(*) filter (where ${chatMessages.messageType} = 'command')::int`
            })
            .from(chatMessages)
            .where(and(eq(chatMessages.channelId, this.channelId), scope));

        const top = await this.db
            .select({
                login: viewers.login,
                messageCount: raw<number>`count(*)::int`
            })
            .from(chatMessages)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatMessages.twitchUserId))
            .where(and(
                eq(chatMessages.channelId, this.channelId),
                // Redemptions are not something anyone "said", so they do not
                // belong in a chatter ranking — the same split the dashboard's
                // numbers make.
                raw`${chatMessages.messageType} <> 'redemption'`,
                scope
            ))
            .groupBy(viewers.login)
            .orderBy(desc(raw`count(*)`))
            .limit(TOP_CHATTERS);

        return {
            messages: totals?.messages ?? 0,
            commandsUsed: totals?.commands ?? 0,
            topChatters: top.map((t) => ({ login: t.login, messageCount: t.messageCount }))
        };
    }

    /** The SQL predicate for a range, or null when there is nothing to scope to. */
    private async windowScope(range: Exclude<AnalyticsRange, 'all_time'>): Promise<SQL | null> {
        if (range === 'last_7_days') {
            // Server-side `now()`, never a timestamp from the client: the range
            // a chip means must not depend on the clock of the machine that
            // clicked it.
            return raw`${chatMessages.messageTime} >= now() - interval '7 days'`;
        }

        const [latest] = await this.db
            .select({ id: streams.id })
            .from(streams)
            .where(eq(streams.channelId, this.channelId))
            .orderBy(desc(streams.startedAt))
            .limit(1);

        return latest ? eq(chatMessages.streamId, latest.id) : null;
    }

    /**
     * The streams table, newest first.
     *
     * Chatters are counted from `chat_messages` rather than read off a column,
     * because the column that used to be there was never written — see
     * migration 0006. One grouped scan per load, under the channel/stream/time
     * index, for a table that shows at most twenty rows.
     */
    private async recentStreams(): Promise<StreamSummaryRecord[]> {
        const rows = await this.db
            .select({
                startedAt: streams.startedAt,
                endedAt: streams.endedAt,
                /*
                 * `count(id)`, never `count(*)`: this is a LEFT JOIN, so a
                 * stream nobody spoke in still produces one row with the
                 * message side all NULL — and `count(*)` would report that
                 * stream as having one message.
                 */
                messages: raw<number>`count(${chatMessages.id}) filter (
                    where ${chatMessages.messageType} <> 'redemption'
                )::int`,
                chatters: raw<number>`count(distinct ${chatMessages.twitchUserId}) filter (
                    where ${chatMessages.messageType} <> 'redemption'
                )::int`
            })
            .from(streams)
            .leftJoin(chatMessages, eq(chatMessages.streamId, streams.id))
            .where(eq(streams.channelId, this.channelId))
            // The primary key, so every selected stream column is functionally
            // dependent on it and Postgres needs nothing else in the clause.
            .groupBy(streams.id)
            .orderBy(desc(streams.startedAt))
            .limit(RECENT_STREAMS);

        return rows.map((row) => ({
            startedAt: row.startedAt.toISOString(),
            endedAt: row.endedAt ? row.endedAt.toISOString() : null,
            messages: row.messages,
            chatters: row.chatters
        }));
    }
}
