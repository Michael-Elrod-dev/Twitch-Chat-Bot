import type { RedemptionHandler } from '../session/redemptionPipeline.js';
import type { SpotifyClient, SpotifyTrack } from '../spotify/spotifyClient.js';
import { parseTrackId } from '../spotify/spotifyClient.js';
import type { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import type { SettingsService } from './settings.js';
import type { Logger } from '../logger.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * `Song Request` and `Skip song queue`, ported from Phase 0.
 *
 * Every failure returns a reason rather than throwing, because the pipeline
 * turns a reason into a refund. A song request that cannot be fulfilled must
 * give the points back — the viewer paid for a song and did not get one.
 */

/** Longer than this and it is a podcast episode, not a song request. */
const MAX_DURATION_MS = 12 * 60_000;

export interface SongRedemptionOptions {
    spotify: SpotifyClient;
    queue: SongQueueRepository;
    settings: SettingsService;
    logger: Logger;
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
            // A pasted link is exact; a bare string is a search. Phase 0
            // accepted both and viewers use both.
            const id = parseTrackId(input);
            track = id ? await options.spotify.getTrack(id) : await options.spotify.searchTrack(input);
        } catch (err) {
            if (err instanceof ManualReauthRequiredError) {
                options.logger.error(
                    { channelId: context.channelId },
                    'Spotify is disconnected - the broadcaster must reconnect at /auth/spotify/connect'
                );
                return 'The music service is not connected right now. Your points have been refunded.';
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

        await context.reply(
            `@${context.event.redeemer.displayName} added "${track.name}" by ${track.artist} to the queue.`
        );

        return null;
    };
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
