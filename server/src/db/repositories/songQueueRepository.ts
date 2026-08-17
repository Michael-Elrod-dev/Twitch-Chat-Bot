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
 * Read and skip only. Adding a song is the redemption path's job — the API
 * deliberately does not offer a way to enqueue, because a track that entered
 * without a redemption would have no channel points behind it and nothing to
 * refund if it were skipped.
 *
 * **Every mutation notifies, as part of the write.** This is the same
 * construction the settings cache uses, applied to the same class of bug and for
 * the same reason: the queue changed and nobody was told.
 *
 * The defect that forced it is worth keeping written down. `song_queue.updated`
 * had exactly ONE publisher — the HTTP skip route — so a song added by
 * redemption and a song handed to Spotify by the playback monitor both changed
 * the queue in silence. Production timeline from the owner's own test: the row
 * was written at `…456228` and handed off at `…577560`, so it sat in the table
 * for **121 seconds** while the app, which had subscribed correctly and was
 * waiting, was never told it existed. The owner reported the queue as never
 * appearing, and they were right.
 *
 * Making the listener a REQUIRED constructor argument is what stops that
 * recurring. An optional one, or a publish call beside each mutation, leaves
 * "someone adds a third way to change the queue and forgets" permanently
 * available — which is precisely what happened. Now the queue cannot be mutated
 * by anything that has not said where the news goes.
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

        if (removed.length === 0) return null;

        await this.announce();
        return head;
    }
}
