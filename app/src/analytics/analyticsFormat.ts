/**
 * How many streams before the footer stops saying the data is young.
 *
 * The handoff's copy is "Four streams in. Trends show up around ten." The four
 * is the channel's real count and belongs to the data, and the ten is the
 * claim the sentence makes and belongs here. One constant, used by both halves of
 * the sentence, so a footer cannot promise trends at ten while appearing at
 * twelve.
 */
export const TREND_THRESHOLD = 10;

/**
 * `Thu 14 Aug`, for the streams table's WHEN column.
 *
 * `en-GB` explicitly rather than the machine's locale, for the same reason the
 * songs card pins its dates: the design draws day-then-month, and a US default
 * would render `Aug 14`, a different table.
 */
export function formatStreamDay(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * `4h 02m`, from a start and an end.
 *
 * Minutes are zero-padded and hours are not, which is what the design draws and
 * what reads as a duration rather than a clock time. A stream under an hour drops
 * the hours entirely, because `0h 47m` is a length written by a computer.
 *
 * An end before its start cannot happen from the server, which closes a stream
 * with a later timestamp than it opened it. Clamped at zero anyway, because the
 * alternative is a table cell reading `-1h 58m` if a clock ever disagrees, and
 * nobody would know what to do with that.
 */
export function formatStreamLength(startedAt: string, endedAt: string): string {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';

    const minutes = Math.max(0, Math.floor((end - start) / 60_000));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    return hours === 0 ? `${rest}m` : `${hours}h ${String(rest).padStart(2, '0')}m`;
}
