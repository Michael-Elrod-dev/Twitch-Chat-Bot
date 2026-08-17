import { useEffect, useRef, useState } from 'react';
import type { NowPlaying } from '@almosthadai/shared';

/** How often the now-playing card re-reads the authority. */
export const PLAYING_POLL_MS = 15_000;

/**
 * How long to wait before the follow-up read after a skip.
 *
 * Spotify's player does not advance synchronously, so the read that immediately
 * follows a skip usually still returns the track just skipped. One deliberate
 * second read closes that gap; the poll above remains the backstop if Spotify is
 * slower than this.
 */
export const SKIP_SETTLE_MS = 1_200;

/** How often the local clock advances the readout between those reads. */
const TICK_MS = 1_000;

/**
 * Advances `progressMs` locally between polls.
 *
 * The same arrangement as the header's uptime clock, for the same reason: the
 * server is the authority on what is playing, and the *position within* it is
 * arithmetic anyone can do. Polling fast enough to animate a progress bar would
 * be one request per second per open app for a number that is `then + elapsed`.
 *
 * Three rules the naive version gets wrong:
 *
 *  - **A paused track does not advance.** `isPlaying` is the gate, and a frozen
 *    bar under a paused player is correct rather than a stall.
 *  - **The local clock never runs past the duration.** Otherwise a track whose
 *    end we have not yet polled reads `4:31 / 4:03`.
 *  - **A poll wins over the local clock, always.** The tick is a guess between
 *    two facts; when a fact arrives it replaces the guess outright, including
 *    backwards if the streamer scrubbed.
 */
export function useAdvancingProgress(source: NowPlaying | null): NowPlaying | null {
    const [progressMs, setProgressMs] = useState(source?.progressMs ?? 0);

    /*
     * When the last authoritative reading arrived, and what it said. Held in a
     * ref rather than state: the tick below reads them, and putting them in the
     * dependency list would restart the interval on every tick.
     */
    const anchor = useRef({ at: 0, progressMs: 0 });

    /*
     * `NowPlaying` carries no track id, so identity is the pair already on the
     * card. Good enough for the one job it has: noticing the track changed, so
     * the local clock re-anchors instead of carrying a position from the
     * previous song into this one.
     */
    const trackKey = source ? `${source.trackName} ${source.artistName}` : null;
    const sourceProgress = source?.progressMs ?? 0;

    useEffect(() => {
        // Re-anchored whenever the server speaks — a new track, or the same
        // track at a position we did not predict.
        anchor.current = { at: Date.now(), progressMs: sourceProgress };
        setProgressMs(sourceProgress);
    }, [trackKey, sourceProgress]);

    const isPlaying = source?.isPlaying ?? false;
    const durationMs = source?.durationMs ?? 0;

    useEffect(() => {
        if (!isPlaying || durationMs <= 0) return undefined;

        const tick = (): void => {
            const elapsed = Date.now() - anchor.current.at;
            // Clamped at the duration: the card must never claim a position past
            // the end of the track it is describing.
            setProgressMs(Math.min(durationMs, anchor.current.progressMs + elapsed));
        };

        const handle = setInterval(tick, TICK_MS);
        return () => { clearInterval(handle); };
    }, [isPlaying, durationMs, trackKey]);

    if (!source) return null;
    return { ...source, progressMs };
}
