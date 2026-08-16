import { and, asc, eq, sql as raw } from 'drizzle-orm';
import { songQueue, viewers, channels } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface QueuedSongRecord {
    id: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    requestedByLogin: string | null;
    createdAt: string;
}

/**
 * The song queue, as the API sees it.
 *
 * Read and skip only. Adding a song is the redemption path's job and arrives
 * with P1-WP4.2 — the API deliberately does not offer a way to enqueue, because
 * a track that entered without a redemption would have no channel points behind
 * it and nothing to refund if it were skipped.
 */
export class SongQueueRepository extends ChannelScopedRepository {
    async list(): Promise<QueuedSongRecord[]> {
        const rows = await this.db
            .select({
                id: songQueue.id,
                trackUri: songQueue.trackUri,
                trackName: songQueue.trackName,
                artistName: songQueue.artistName,
                requestedByLogin: viewers.login,
                createdAt: songQueue.addedAt
            })
            .from(songQueue)
            // Left join: a purged requester SET NULLs the reference, and the
            // song is still in the queue.
            .leftJoin(viewers, eq(viewers.twitchUserId, songQueue.requestedByTwitchUserId))
            .where(eq(songQueue.channelId, this.channelId))
            .orderBy(asc(songQueue.addedAt));

        return rows.map((r) => ({
            id: r.id,
            trackUri: r.trackUri,
            trackName: r.trackName ?? '',
            artistName: r.artistName ?? '',
            requestedByLogin: r.requestedByLogin,
            createdAt: r.createdAt.toISOString()
        }));
    }

    /**
     * Appends a requested track.
     *
     * Only the redemption path calls this — there is deliberately no API route
     * to enqueue, because a track that entered without a redemption has no
     * channel points behind it and nothing to refund if it is skipped.
     */
    async add(track: {
        trackUri: string;
        trackName: string;
        artistName: string;
        requestedByTwitchUserId: string | null;
    }): Promise<void> {
        // The position is allocated under a channel row lock, the same shape
        // quote numbering uses: two simultaneous redemptions would otherwise
        // read the same max and both claim it.
        await this.db.transaction(async (tx) => {
            await tx
                .select({ id: channels.id })
                .from(channels)
                .where(eq(channels.id, this.channelId))
                .for('update');

            const [row] = await tx
                .select({ next: raw<number>`coalesce(max(${songQueue.queuePosition}), 0) + 1` })
                .from(songQueue)
                .where(eq(songQueue.channelId, this.channelId));

            /*
             * `requested_by_twitch_user_id` references `viewers`, and a viewer
             * can redeem channel points without ever having chatted - so the
             * requester may genuinely not exist yet. Null is the accurate
             * answer there, not a lost attribution: there is no viewer record
             * to point at. The queue still shows the track.
             */
            let requestedBy = track.requestedByTwitchUserId;
            if (requestedBy !== null) {
                const [known] = await tx
                    .select({ id: viewers.twitchUserId })
                    .from(viewers)
                    .where(eq(viewers.twitchUserId, requestedBy))
                    .limit(1);
                if (!known) requestedBy = null;
            }

            await tx.insert(songQueue).values({
                channelId: this.channelId,
                queuePosition: row?.next ?? 1,
                trackUri: track.trackUri,
                trackName: track.trackName,
                artistName: track.artistName,
                requestedByTwitchUserId: requestedBy
            });
        });
    }

    /** @returns whether this track is already queued for this channel. */
    async contains(trackUri: string): Promise<boolean> {
        const [row] = await this.db
            .select({ id: songQueue.id })
            .from(songQueue)
            .where(and(eq(songQueue.channelId, this.channelId), eq(songQueue.trackUri, trackUri)))
            .limit(1);

        return row !== undefined;
    }

    async count(): Promise<number> {
        return (await this.list()).length;
    }

    /**
     * Removes and returns the oldest queued track — the Stream Deck skip.
     *
     * @returns the removed song, or null when the queue was already empty.
     */
    async removeHead(): Promise<QueuedSongRecord | null> {
        const [head] = await this.list();
        if (!head) return null;

        // Deleted by id rather than re-selecting the oldest: two concurrent
        // skips would otherwise both read the same head and the second would
        // remove a track nobody skipped.
        const removed = await this.db
            .delete(songQueue)
            .where(eq(songQueue.id, head.id))
            .returning({ id: songQueue.id });

        return removed.length > 0 ? head : null;
    }
}
