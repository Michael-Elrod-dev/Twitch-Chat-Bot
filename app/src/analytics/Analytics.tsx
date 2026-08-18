import { useMemo, useState } from 'react';
import type { AnalyticsRange, AnalyticsSummary, StreamSummary } from '@almosthadai/shared';
import type { SessionStorage } from '../auth/sessionStore.js';
import { useResource } from '../api/useResource.js';
import { ContentBanner } from '../content/ContentBanner.js';
import { formatFullDate } from '../songs/songsFormat.js';
import { formatStreamDay, formatStreamLength, TREND_THRESHOLD } from './analyticsFormat.js';

/**
 * Analytics (`3d`).
 *
 * The young-data framing is the design, not a fallback. A young channel's four
 * streams and five-name chatter list are the real numbers, and the handoff is
 * explicit that they are rendered as facts rather than as an apology. There is no
 * "not enough data yet" state here. The footer says how young the data is and the
 * cards show what there is.
 *
 * The chips are three windows over one dataset. `all_time` is the default because
 * it is the cheap one. It reads the counters the bot maintains per message,
 * where the other two scan the message table. That is the repository's reasoning,
 * repeated here only to explain why the screen opens where it does.
 */

const RANGES: { id: AnalyticsRange; label: string }[] = [
    { id: 'all_time', label: 'All time' },
    { id: 'this_stream', label: 'This stream' },
    { id: 'last_7_days', label: 'Last 7 days' }
];

export interface AnalyticsProps {
    storage: SessionStorage;
}

export function Analytics({ storage }: AnalyticsProps): React.JSX.Element {
    const [range, setRange] = useState<AnalyticsRange>('all_time');

    /*
     * The range is in the path, so switching chips changes the hook's key and
     * re-fetches, and `useResource`'s sequence guard is what stops a slow
     * `all_time` response landing after a fast `this_stream` one and relabelling
     * the chip the user is looking at. The response echoes its own range for the
     * same reason from the server's side.
     */
    const summary = useResource<AnalyticsSummary>({
        path: `/api/v1/analytics/summary?range=${range}`,
        storage
    });

    const data = summary.data;

    /**
     * The header's date, and it is NOT a "since".
     *
     * The design draws `since 1 Aug 2026`, meaning "this is how far back the data
     * goes". The contract has no earliest-stream field, and `lastStreamAt` is the
     * most recent one, so wiring the design's label to the field that exists
     * produces `since 14 Aug 2026` over figures that include everything before it.
     * Only reading the rendered header catches that, which is the
     * only place the two halves of a sentence sit next to each other.
     *
     * `recentStreams` is not the answer either: it is capped at twenty, so its
     * oldest entry is the earliest stream for this channel today and silently
     * stops being that later. The label now says what the field is.
     */
    const lastStream = formatFullDate(data?.lastStreamAt ?? null);

    /*
     * The bar scale, from the biggest count in the list rather than from the
     * total. A bar drawn as a share of all messages would be a hairline for
     * everyone, which is a chart that answers no question.
     */
    const topCount = useMemo(
        () => Math.max(1, ...(data?.topChatters ?? []).map((c) => c.messageCount)),
        [data]
    );

    return (
        <div className="content-page">
            <header className="content-header">
                <h1 className="content-title">Analytics</h1>
                {/* Omitted entirely before the first stream, because a bare
                    "last stream" label would be worse than nothing. */}
                {lastStream && <span className="content-meta">last stream {lastStream}</span>}

                <div className="content-header__spacer" />

                <div className="chip-row">
                    {RANGES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            aria-pressed={range === option.id}
                            className={`filter-chip${range === option.id ? ' filter-chip--on' : ''}`}
                            onClick={() => { setRange(option.id); }}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </header>

            {summary.banner && (
                <ContentBanner message={summary.banner} onDismiss={summary.dismissBanner} />
            )}

            <div className="numbers__row">
                <StatCard value={data?.messages ?? null} label="messages" />
                <StatCard value={data?.viewers ?? null} label="people known" />
                <StatCard value={data?.commandsUsed ?? null} label="commands used" />
                <StatCard value={data?.streams ?? null} label="streams tracked" />
            </div>

            <div className="analytics__split">
                <section className="card">
                    <header className="card__header">
                        <h2 className="card__title">Top chatters</h2>
                    </header>
                    {(data?.topChatters ?? []).length === 0
                        ? (
                            <div className="analytics__quiet">
                                Nobody has said anything in this window yet.
                            </div>
                        )
                        : (
                            <div className="chatters">
                                {data?.topChatters.map((chatter) => (
                                    <div className="chatter" key={chatter.login}>
                                        <span className="chatter__row">
                                            <span className="chatter__name">{chatter.login}</span>
                                            <span className="chatter__count">
                                                {chatter.messageCount.toLocaleString('en-GB')}
                                            </span>
                                        </span>
                                        <span className="chatter__bar" aria-hidden="true">
                                            <span
                                                className="chatter__bar-fill"
                                                style={{
                                                    width: `${((chatter.messageCount / topCount) * 100).toFixed(2)}%`
                                                }}
                                            />
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                </section>

                <section className="card">
                    <header className="card__header">
                        <h2 className="card__title">Streams</h2>
                    </header>

                    {(data?.recentStreams ?? []).length === 0
                        ? (
                            <div className="analytics__quiet">
                                The first stream with the bot connected shows up here.
                            </div>
                        )
                        : (
                            <>
                                <div className="list-grid list-grid--streams list-grid__head">
                                    <span>WHEN</span>
                                    <span>LENGTH</span>
                                    <span>MESSAGES</span>
                                    <span>CHATTERS</span>
                                </div>
                                {data?.recentStreams.map((stream) => (
                                    <StreamRow key={stream.startedAt} stream={stream} />
                                ))}
                            </>
                        )}

                    {/*
                      * The footer is where the young-data framing is said out
                      * loud, and it counts the real streams rather than repeating
                      * the design's "Four". It disappears once there is enough
                      * history for trends to mean something, because then the
                      * sentence would be false.
                      */}
                    {data && data.streams > 0 && data.streams < TREND_THRESHOLD && (
                        <div className="card__footer">
                            {data.streams === 1
                                ? `One stream in. Trends show up around ${TREND_THRESHOLD}.`
                                : `${data.streams} streams in. Trends show up around ${TREND_THRESHOLD}.`}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

/**
 * One big figure.
 *
 * `null` is "not loaded yet" and renders the skeleton block the dashboard's
 * unreachable state uses. It is never rendered as `0`, which would be a claim
 * about a channel rather than an admission about a request, which is the same
 * rule the dashboard's degraded state enforces.
 */
function StatCard({ value, label }: { value: number | null; label: string }): React.JSX.Element {
    return (
        <div className="number-card">
            {value === null
                ? <span className="number-card__skeleton" aria-hidden="true" />
                : <span className="number-card__figure">{value.toLocaleString('en-GB')}</span>}
            <span className="number-card__label">{label}</span>
        </div>
    );
}

function StreamRow({ stream }: { stream: StreamSummary }): React.JSX.Element {
    return (
        <div className="list-grid list-grid--streams list-row">
            <span className="list-row__when-day">{formatStreamDay(stream.startedAt)}</span>
            {/* An open stream has no length yet. "live" rather than a dash: the
                row is about a stream that is happening, which is more useful to
                say than that a number is missing. */}
            <span className="list-row__cell">
                {stream.endedAt === null
                    ? <span className="list-row__live">live</span>
                    : formatStreamLength(stream.startedAt, stream.endedAt)}
            </span>
            <span className="list-row__cell">{stream.messages.toLocaleString('en-GB')}</span>
            <span className="list-row__cell">{stream.chatters.toLocaleString('en-GB')}</span>
        </div>
    );
}
