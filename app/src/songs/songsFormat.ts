/**
 * The four things the songs screen has to turn into words.
 *
 * Kept out of the components because every one of them has an edge that is easy
 * to get wrong and worth a test: a track under ten seconds, a request made
 * seconds ago, a date rendered in the wrong locale's month order.
 */

/**
 * `1:34`, from milliseconds.
 *
 * `m:ss` and not `mm:ss` — the handoff draws `1:34 / 4:03`, and a leading zero
 * on the minutes would make a four-minute song read like a stopwatch. Seconds
 * always get theirs, because `1:4` is not a time.
 *
 * Floors rather than rounds: a progress readout that reaches `4:03` before the
 * track ends is claiming the song is over.
 */
export function formatTrackTime(ms: number): string {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const total = Math.floor(safe / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How full the progress bar is, 0–1.
 *
 * Clamped at both ends. Spotify can report a position past the duration during
 * a track change, and a bar wider than its track is a visible glitch on a screen
 * whose whole job is to look calm on a second monitor.
 */
export function trackProgress(progressMs: number, durationMs: number): number {
    if (!Number.isFinite(progressMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
    return Math.min(1, Math.max(0, progressMs / durationMs));
}

/**
 * `2 min ago`, for the queue's WHEN column.
 *
 * Minutes are the unit the design draws and the unit that matters: a request is
 * interesting for the twenty minutes it spends waiting, and "0 min ago" for
 * something that just landed would read as a bug — hence `just now`. Hours
 * appear because a queue can outlive an hour when nobody is skipping.
 */
export function formatWaiting(createdAt: string, now: Date = new Date()): string {
    const at = new Date(createdAt).getTime();
    if (!Number.isFinite(at)) return '';

    const minutes = Math.floor((now.getTime() - at) / 60_000);
    // A clock a few seconds behind the server's puts a request in the future.
    // "in −1 min" is nonsense; "just now" is true enough and unremarkable.
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.floor(minutes / 60);
    return hours === 1 ? '1 hr ago' : `${hours} hrs ago`;
}

/**
 * `4 Aug`, for the Spotify card's "since" line.
 *
 * Day-then-month with an explicit `en-GB` locale rather than the machine's: the
 * design draws `since 4 Aug` and a US default would render `Aug 4`, which is a
 * different design. The year is dropped because the card is about a link made
 * recently; `formatFullDate` is for the places that need it.
 */
export function formatShortDate(iso: string | null): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;

    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** `1 Aug 2026` — the analytics header's "since", where the year is the point. */
export function formatFullDate(iso: string | null): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;

    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
