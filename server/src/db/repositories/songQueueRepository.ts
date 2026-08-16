import { asc, eq } from 'drizzle-orm';
import { songQueue, viewers } from '../schema/index.js';
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
