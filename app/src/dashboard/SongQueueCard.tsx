import { Music } from 'lucide-react';
import type { QueuedSong } from '@almosthadai/shared';

/**
 * The two-stage song queue.
 *
 * `PLAYING IN SPOTIFY` and `WAITING IN THE BOT` are the entire explanation of
 * how requests work here, and the handoff is explicit that no prose is to be
 * added under them. Two labels do the job a paragraph would do worse.
 *
 * The now-playing half has no source in the contract yet — Spotify playback is
 * the songs screen's surface and lands with it — so this renders that stage's
 * placeholder rather than inventing a track. The stage still appears, because
 * the label is what explains the queue.
 */

export interface SongQueueCardProps {
    queue: QueuedSong[];
    /** Hides the count in favour of the `REQUESTS OPEN` pill when offline. */
    offline: boolean;
    requestsEnabled: boolean;
    /** True when we cannot see the server: the count is unknowable. */
    unknown: boolean;
    /**
     * True when Twitch has cut the bot off.
     *
     * Suppresses the `REQUESTS OPEN` pill, which would otherwise be a promise
     * the channel cannot keep: the setting is on, but nobody can redeem the
     * reward while the bot is locked out, and a viewer told requests were open
     * would spend points on nothing.
     */
    revoked: boolean;
    emptyCopy: string;
}

export function SongQueueCard({
    queue,
    offline,
    requestsEnabled,
    unknown,
    revoked,
    emptyCopy
}: SongQueueCardProps): React.JSX.Element {
    const showPill = offline && requestsEnabled && !unknown && !revoked;

    return (
        <section className="card queue-card">
            <header className="card__header">
                <h2 className="card__title">Song queue</h2>
                {showPill
                    ? <span className="pill pill--requests">REQUESTS OPEN</span>
                    : <span className="card__meta">{unknown ? '?' : `${queue.length} waiting`}</span>}
            </header>

            {queue.length === 0 || unknown
                ? (
                    <div className="empty-panel">
                        <span className="empty-panel__glyph" aria-hidden="true">
                            <Music size={16} />
                        </span>
                        <p className="empty-panel__copy">{emptyCopy}</p>
                    </div>
                )
                : (
                    <div className="queue-card__body">
                        <div className="queue-stage">
                            <span className="queue-stage__label">PLAYING IN SPOTIFY</span>
                            <div className="queue-now">
                                <span className="queue-now__art" aria-hidden="true" />
                                <span className="queue-now__meta">Nothing playing</span>
                            </div>
                        </div>

                        <div className="queue-stage">
                            <span className="queue-stage__label">WAITING IN THE BOT</span>
                            <ol className="queue-list">
                                {queue.map((song, index) => (
                                    <li className="queue-row" key={song.id}>
                                        <span className="queue-row__index">{index + 1}</span>
                                        <span className="queue-row__stack">
                                            <span className="queue-row__track">{song.trackName}</span>
                                            <span className="queue-row__artist">
                                                {song.artistName}
                                                {song.requestedByLogin ? ` · ${song.requestedByLogin}` : ''}
                                            </span>
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    </div>
                )}
        </section>
    );
}
