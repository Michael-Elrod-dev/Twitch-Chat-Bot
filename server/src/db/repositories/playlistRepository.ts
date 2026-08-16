import { and, eq } from 'drizzle-orm';
import { playlistAdditions } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

/**
 * The requests-playlist dedup record.
 *
 * `claim` is deliberately a write-that-answers rather than a read-then-write:
 * two viewers requesting the same track at the same moment must produce one
 * append, and a check-then-insert has a window between the two where both see
 * "not present". The unique index decides it instead.
 */
export class PlaylistRepository extends ChannelScopedRepository {
    /**
     * @returns true when THIS call won the right to append the track, false
     * when it was already saved to this playlist.
     */
    async claim(playlistId: string, trackUri: string): Promise<boolean> {
        const inserted = await this.db
            .insert(playlistAdditions)
            .values({ channelId: this.channelId, playlistId, trackUri })
            .onConflictDoNothing({
                target: [
                    playlistAdditions.channelId,
                    playlistAdditions.playlistId,
                    playlistAdditions.trackUri
                ]
            })
            .returning({ id: playlistAdditions.id });

        return inserted.length > 0;
    }

    /**
     * Releases a claim.
     *
     * Called when the append itself fails: keeping the row would mean the track
     * is recorded as saved while Spotify never received it, and no later
     * request would ever retry it.
     */
    async release(playlistId: string, trackUri: string): Promise<void> {
        await this.db
            .delete(playlistAdditions)
            .where(and(
                eq(playlistAdditions.channelId, this.channelId),
                eq(playlistAdditions.playlistId, playlistId),
                eq(playlistAdditions.trackUri, trackUri)
            ));
    }
}
