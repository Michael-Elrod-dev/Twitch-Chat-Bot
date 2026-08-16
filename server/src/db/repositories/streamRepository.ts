import { and, desc, eq, isNull, sql as raw } from 'drizzle-orm';
import { streams, viewingSessions } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface StreamRecord {
    id: string;
    twitchStreamId: string | null;
    startedAt: Date;
    endedAt: Date | null;
    title: string | null;
    category: string | null;
}

/**
 * Stream sessions.
 *
 * Phase 0 minted `Date.now().toString()` as the stream id, so its rows can only
 * be correlated with Twitch by eyeballing timestamps. Every row written here
 * carries Twitch's own id from the `stream.online` payload, which is what makes
 * a stream identifiable across a restart — and what lets `open()` be idempotent
 * rather than trusting the process to remember.
 */
export class StreamRepository extends ChannelScopedRepository {
    /**
     * Opens a stream, or returns the existing one.
     *
     * EventSub is at-least-once, so `stream.online` can arrive twice for one
     * stream. The unique index on (channel_id, twitch_stream_id) makes the
     * second arrival a no-op instead of a duplicate stream.
     */
    async open(input: {
        twitchStreamId: string;
        startedAt: Date;
        title: string | null;
        category: string | null;
    }): Promise<StreamRecord> {
        const [row] = await this.db
            .insert(streams)
            .values({
                channelId: this.channelId,
                twitchStreamId: input.twitchStreamId,
                startedAt: input.startedAt,
                title: input.title,
                category: input.category
            })
            .onConflictDoUpdate({
                target: [streams.channelId, streams.twitchStreamId],
                set: {
                    // Metadata may have been unknown on the first attempt (Helix
                    // lags the event by a second or two); a retry may know better.
                    title: input.title,
                    category: input.category,
                    /*
                     * Reopen, do not just touch.
                     *
                     * Twitch keeps the same stream id across a brief drop, so a
                     * flaky connection produces offline-then-online for ONE
                     * stream. Leaving `ended_at` set would make the row invisible
                     * to findOpen: the channel is live, the service believes it
                     * is offline, and the AI bucket and !uptime both go wrong for
                     * the rest of the stream.
                     */
                    endedAt: null
                }
            })
            .returning();

        return toRecord(row);
    }

    /** @returns the stream still running for this channel, if any. */
    async findOpen(): Promise<StreamRecord | null> {
        const [row] = await this.db
            .select()
            .from(streams)
            .where(and(eq(streams.channelId, this.channelId), isNull(streams.endedAt)))
            // Newest first: a crash mid-stream can leave an older row open, and
            // the current stream is the one that matters.
            .orderBy(desc(streams.startedAt))
            .limit(1);

        return row ? toRecord(row) : null;
    }

    /**
     * Closes the open stream and every viewing session inside it.
     *
     * Both halves in one statement pair because a closed stream with sessions
     * still open would report viewers watching a stream that ended - the exact
     * orphan the legacy tracker had to sweep for on boot.
     */
    async close(streamId: string, endedAt: Date): Promise<boolean> {
        const closed = await this.db
            .update(streams)
            .set({ endedAt })
            .where(and(
                eq(streams.id, streamId),
                eq(streams.channelId, this.channelId),
                isNull(streams.endedAt)
            ))
            .returning({ id: streams.id });

        if (closed.length === 0) return false;

        await this.db
            .update(viewingSessions)
            .set({ endedAt })
            .where(and(
                eq(viewingSessions.streamId, streamId),
                eq(viewingSessions.channelId, this.channelId),
                isNull(viewingSessions.endedAt)
            ));

        return true;
    }

    /** Rolls the per-stream aggregates the analytics surface reads. */
    async recordMessage(streamId: string): Promise<void> {
        await this.db
            .update(streams)
            .set({ totalMessages: raw`${streams.totalMessages} + 1` })
            .where(and(eq(streams.id, streamId), eq(streams.channelId, this.channelId)));
    }

    async setPeakViewers(streamId: string, viewers: number): Promise<void> {
        await this.db
            .update(streams)
            .set({ peakViewers: raw`greatest(${streams.peakViewers}, ${viewers})` })
            .where(and(eq(streams.id, streamId), eq(streams.channelId, this.channelId)));
    }

    async setUniqueChatters(streamId: string, count: number): Promise<void> {
        await this.db
            .update(streams)
            .set({ uniqueChatters: count })
            .where(and(eq(streams.id, streamId), eq(streams.channelId, this.channelId)));
    }
}

function toRecord(row: typeof streams.$inferSelect | undefined): StreamRecord {
    if (!row) throw new Error('stream row missing after write');

    return {
        id: row.id,
        twitchStreamId: row.twitchStreamId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        title: row.title,
        category: row.category
    };
}
