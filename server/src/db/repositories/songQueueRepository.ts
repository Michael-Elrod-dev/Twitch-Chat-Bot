import { and, asc, eq, sql as raw } from 'drizzle-orm';
import { songQueue, viewers, channels } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { Database } from '../client.js';

export interface QueuedSongRecord {
    id: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    requestedByLogin: string | null;
    createdAt: string;
}

/**
 * Told that this channel's queue changed, with the length it changed to.
 *
 * Synchronous and returning nothing on purpose: publishing to the live bus must
 * not be able to fail a redemption or a skip. A viewer who spent points has
 * bought a queued song, not a delivered WebSocket frame.
 */
export type QueueChangedListener = (queueLength: number) => void;

/**
 * The song queue, as the API sees it.
 *
 * Read and skip only. Adding a song is the redemption path's job, and the API
 * deliberately does not offer a way to enqueue, because a track that entered
 * without a redemption would have no channel points behind it and nothing to
 * refund if it were skipped.
 *
 * Every mutation notifies, as part of the write. This is the same construction
 * the settings cache uses, for the same reason, which is that a queue nobody is
 * told about looks to the app like a queue that never changed.
 *
 * The listener is a required constructor argument rather than an optional one,
 * and rather than a publish call written beside each mutation. Either of those
 * leaves "someone adds a third way to change the queue and forgets" permanently
 * available. As written, the queue cannot be mutated by anything that has not
 * said where the news goes.
 */
export class SongQueueRepository extends ChannelScopedRepository {
    private readonly onChanged: QueueChangedListener;

    constructor(db: Database, channelId: string, onChanged: QueueChangedListener) {
        super(db, channelId);
        this.onChanged = onChanged;
    }

    /**
     * Announces the queue's new length.
     *
     * Never throws into its caller: a listener that fails is a delivery problem,
     * and a redemption that already wrote its row must still report success to
     * the viewer who paid for it.
     */
    private async announce(): Promise<void> {
        try {
            this.onChanged(await this.count());
        } catch {
            /* A broken listener cannot un-queue a song. */
        }
    }

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
     * Only the redemption path calls this. There is deliberately no API route
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

        // After the transaction commits, so the length announced is one a reader
        // would actually see.
        await this.announce();
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
     * Removes and returns the oldest queued track, which is the Stream Deck skip.
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

        if (removed.length === 0) return null;

        await this.announce();
        return head;
    }
}
