import type { Logger } from '../logger.js';
import type { SpotifyClient } from './spotifyClient.js';
import type { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * Feeds queued tracks into Spotify as the current one ends.
 *
 * Two Phase-0 gates are ported and both are load-bearing:
 *
 *  - **The `is_playing` gate.** If playback is paused, the queue does not
 *    advance. Without it a streamer who pauses for five minutes returns to an
 *    empty queue: every track "ended" on the timer and was handed to Spotify
 *    while nothing was listening. The viewers paid points for songs nobody
 *    heard.
 *  - **Advance near the end, not at the end.** Spotify's queue needs the track
 *    before the current one finishes, or there is a silent gap.
 *
 * Lifecycle follows the P1-WP4 discipline: start and stop are idempotent, stop
 * is safe on a monitor that never started, and the interval is unref'd so it
 * can never hold the process open.
 */

/** How close to the end counts as "about to finish". */
const ADVANCE_WINDOW_MS = 10_000;

/** Polling cadence. Phase 0 used 3s; the same trade of freshness against calls. */
const DEFAULT_POLL_MS = 3_000;

export interface PlaybackMonitorOptions {
    channelId: string;
    client: SpotifyClient;
    queue: SongQueueRepository;
    logger: Logger;
    pollMs?: number;
    /** Injectable so tests drive time rather than wait for it. */
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
}

export class PlaybackMonitor {
    private readonly options: PlaybackMonitorOptions;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    /** Guards against a slow tick overlapping the next one. */
    private ticking = false;

    /** The track we last handed to Spotify, so it is not queued twice. */
    private lastQueuedUri: string | null = null;

    /** What that track was, for `!lastsong`. In memory only, by design. */
    private lastPlayedTrack: { trackName: string; artistName: string } | null = null;

    /**
     * The uri and requester of that same handoff, for the now-playing card.
     *
     * This is the only place the pairing survives. The monitor removes the row
     * from the queue at the instant it hands the track to Spotify, so by the
     * time the track is *playing* — which is when the card asks — the requester
     * is no longer in any table. Recording it here costs one field; the
     * alternative would be a played-history table for one line of UI.
     *
     * In memory, like `lastPlayedTrack`: after a restart the card shows the
     * track with no requester, which is honest — we genuinely no longer know.
     */
    private lastHandoff: { trackUri: string; requestedByLogin: string | null } | null = null;

    constructor(options: PlaybackMonitorOptions) {
        this.options = options;
    }

    get isRunning(): boolean {
        return this.running;
    }

    /** @returns the last track advanced to this session, or null after a restart. */
    lastPlayed(): { trackName: string; artistName: string } | null {
        return this.lastPlayedTrack;
    }

    /**
     * @returns who requested `trackUri`, when it is the track this monitor last
     * handed to Spotify. Null for anything else — including a track the
     * streamer started themselves, which is most of a stream.
     *
     * Matched on the uri rather than assumed: the streamer can skip in Spotify
     * at any moment, and attributing whatever is playing now to the last
     * requester would credit a stranger's song to a viewer.
     */
    requesterOf(trackUri: string): string | null {
        if (!this.lastHandoff || this.lastHandoff.trackUri !== trackUri) return null;
        return this.lastHandoff.requestedByLogin;
    }

    start(): void {
        if (this.running) {
            this.options.logger.debug({ channelId: this.options.channelId }, 'Playback monitor already running');
            return;
        }
        this.running = true;

        const setIntervalFn = this.options.setIntervalImpl ?? setInterval;
        this.timer = setIntervalFn(() => {
            void this.tick();
        }, this.options.pollMs ?? DEFAULT_POLL_MS);

        // Never hold the process open for a poller.
        this.timer.unref?.();

        this.options.logger.info({ channelId: this.options.channelId }, 'Playback monitor started');
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;

        if (this.timer) {
            (this.options.clearIntervalImpl ?? clearInterval)(this.timer);
            this.timer = null;
        }

        this.lastQueuedUri = null;
        this.options.logger.info({ channelId: this.options.channelId }, 'Playback monitor stopped');
    }

    /** Exposed so tests can drive a tick without waiting on wall-clock time. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;

        try {
            const state = await this.options.client.getPlaybackState();

            // Nothing playing, or no active device. Not an error - a streamer
            // with Spotify closed is an ordinary state.
            if (!state) return;

            // THE GATE. A paused stream must not drain the queue into a player
            // nobody is listening to.
            if (!state.isPlaying) return;

            const remainingMs = state.durationMs - state.progressMs;
            if (state.durationMs === 0 || remainingMs > ADVANCE_WINDOW_MS) return;

            const [next] = await this.options.queue.list();
            if (!next) return;

            // Queueing the same track twice would happen on every tick inside
            // the ten-second window.
            if (next.trackUri === this.lastQueuedUri) return;

            await this.options.client.queueTrack(next.trackUri);
            this.lastQueuedUri = next.trackUri;
            this.lastPlayedTrack = { trackName: next.trackName, artistName: next.artistName };
            this.lastHandoff = { trackUri: next.trackUri, requestedByLogin: next.requestedByLogin };

            await this.options.queue.removeHead();

            this.options.logger.info(
                { channelId: this.options.channelId, track: next.trackName, artist: next.artistName },
                'Queued the next requested track'
            );
        } catch (err) {
            /*
             * A dead Spotify authorization is NOT transient. Polling on would
             * attempt a refresh that cannot succeed, every three seconds, until
             * somebody noticed — so the monitor stops itself and says why. It
             * starts again when the broadcaster reconnects, because that
             * rebuilds the session.
             */
            if (err instanceof ManualReauthRequiredError) {
                this.options.logger.error(
                    { channelId: this.options.channelId },
                    'Spotify authorization is no longer valid - stopping the playback monitor. Reconnect at /auth/spotify/connect'
                );
                this.stop();
                return;
            }

            // Anything else is transient by nature: log and let the next tick
            // try. Throwing here would kill the interval entirely.
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Playback monitor tick failed'
            );
        } finally {
            this.ticking = false;
        }
    }
}
