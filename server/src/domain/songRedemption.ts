import type { RedemptionHandler } from '../session/redemptionPipeline.js';
import type { SpotifyClient, SpotifyTrack } from '../spotify/spotifyClient.js';
import { parseTrackId } from '../spotify/spotifyClient.js';
import type { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import type { PlaylistRepository } from '../db/repositories/playlistRepository.js';
import type { SettingsService } from './settings.js';
import type { Logger } from '../logger.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * `Song Request` and `Skip song queue`.
 *
 * Every failure returns a reason rather than throwing, because the pipeline
 * turns a reason into a refund. A song request that cannot be fulfilled must
 * give the points back, because the viewer paid for a song and did not get one.
 */

/** Longer than this and it is a podcast episode, not a song request. */
const MAX_DURATION_MS = 12 * 60_000;

export interface SongRedemptionOptions {
    spotify: SpotifyClient;
    queue: SongQueueRepository;
    settings: SettingsService;
    logger: Logger;
    /** Dedup record for the requests playlist. Absent means the feature is off. */
    playlist?: PlaylistRepository;
}

export function createSongRequestHandler(options: SongRedemptionOptions): RedemptionHandler {
    return async (context) => {
        const input = context.event.userInput.trim();

        if (input === '') {
            return 'You need to include a Spotify link or a song name. Your points have been refunded.';
        }

        const settings = await options.settings.get();
        if (!settings.songRequestsEnabled) {
            return 'Song requests are currently turned off. Your points have been refunded.';
        }

        let track: SpotifyTrack | null;
        try {
            // A pasted link is exact and a bare string is a search. Viewers
            // use both.
            const id = parseTrackId(input);
            track = id ? await options.spotify.getTrack(id) : await options.spotify.searchTrack(input);
        } catch (err) {
            if (err instanceof ManualReauthRequiredError) {
                options.logger.error(
                    { channelId: context.channelId },
                    'Spotify is disconnected - the broadcaster must reconnect at /auth/spotify/connect'
                );
                return 'Spotify is not connected right now. Your points have been refunded.';
            }

            options.logger.warn(
                { channelId: context.channelId, err: (err as Error).message },
                'Track lookup failed'
            );
            return 'I could not reach Spotify just now. Your points have been refunded.';
        }

        if (!track || track.uri === '') {
            return `I could not find "${input}" on Spotify. Your points have been refunded.`;
        }

        if (track.durationMs > MAX_DURATION_MS) {
            return `"${track.name}" is too long for the queue. Your points have been refunded.`;
        }

        // A duplicate would play twice and the second listener paid for nothing
        // new, so it refunds rather than silently collapsing.
        if (await options.queue.contains(track.uri)) {
            return `"${track.name}" is already in the queue. Your points have been refunded.`;
        }

        await options.queue.add({
            trackUri: track.uri,
            trackName: track.name,
            artistName: track.artist,
            requestedByTwitchUserId: context.event.redeemer.twitchUserId
        });

        options.logger.info(
            { channelId: context.channelId, track: track.name, by: context.event.redeemer.login },
            'Song queued by redemption'
        );

        await saveToPlaylist(options, settings, context.channelId, track);

        /*
         * Deliberately not "added to the queue".
         *
         * That phrasing reads as Spotify's own queue, and a viewer who goes
         * looking for the track there will not find it. This is the request
         * list, and the track reaches Spotify only when the current song ends.
         * Saying where it sits is the difference between "nothing happened" and
         * "it is coming".
         */
        const position = (await options.queue.list()).length;
        const ahead = position - 1;

        await context.reply(
            `@${context.event.redeemer.displayName} "${track.name}" by ${track.artist} is #${position} in the request list`
            + (ahead > 0
                ? ` - ${ahead} song${ahead === 1 ? '' : 's'} ahead of it.`
                : ' - it plays when the current song ends.')
        );

        return null;
    };
}

/**
 * Appends the track to the channel's requests playlist.
 *
 * Best-effort by design and never a refund. The viewer's song is queued and
 * will play, and failing their redemption because a bookkeeping playlist could
 * not be written would take their points for a problem they cannot see.
 *
 * Dedup is the database claim, never a playlist read. Paging the whole playlist
 * on every request would be an unbounded number of Spotify calls on the
 * redemption path, growing with the playlist.
 */
async function saveToPlaylist(
    options: SongRedemptionOptions,
    settings: { requestsPlaylistEnabled: boolean; requestsPlaylistId: string | null },
    channelId: string,
    track: SpotifyTrack
): Promise<void> {
    const playlistId = settings.requestsPlaylistId;
    if (!options.playlist || !settings.requestsPlaylistEnabled || !playlistId) return;

    // Claim first: winning the insert is what makes this the one caller that
    // appends, even if two viewers request the same track simultaneously.
    if (!await options.playlist.claim(playlistId, track.uri)) {
        options.logger.debug(
            { channelId, track: track.name },
            'Track is already in the requests playlist'
        );
        return;
    }

    try {
        await options.spotify.addToPlaylist(playlistId, track.uri);
        options.logger.info({ channelId, track: track.name }, 'Saved to the requests playlist');
    } catch (err) {
        // Release the claim, or the track is recorded as saved while Spotify
        // never received it and no later request would ever retry it.
        await options.playlist.release(playlistId, track.uri);
        options.logger.warn(
            { channelId, track: track.name, err: (err as Error).message },
            'Could not save to the requests playlist - the song is still queued'
        );
    }
}

export function createSkipQueueHandler(options: SongRedemptionOptions): RedemptionHandler {
    return async (context) => {
        const removed = await options.queue.removeHead();

        if (!removed) {
            // Nothing to skip is a refund: the viewer paid to change something
            // and nothing changed.
            return 'There was nothing in the queue to skip. Your points have been refunded.';
        }

        options.logger.info(
            { channelId: context.channelId, track: removed.trackName, by: context.event.redeemer.login },
            'Queued song skipped by redemption'
        );

        await context.reply(
            `@${context.event.redeemer.displayName} skipped "${removed.trackName}" from the queue.`
        );

        return null;
    };
}
