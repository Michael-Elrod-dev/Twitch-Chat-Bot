import { Music } from 'lucide-react';
import type { NowPlaying } from '@almosthadai/shared';
import { formatTrackTime, trackProgress } from './songsFormat.js';

/**
 * What Spotify is playing, above the queue that feeds it.
 *
 * **Nothing playing is an ordinary state, not an empty one.** Most of a stream
 * has a track in it and the rest has a paused player or a closed app, so this
 * keeps its frame and says so in one line rather than dropping a dashed-square
 * empty panel into the top of the page every time the streamer pauses.
 *
 * **Skip acts on this track and nothing else.** It calls `POST /songs/skip`,
 * which advances Spotify's player — NOT `DELETE /songs/head`, which drops the
 * next waiting request. The two were briefly conflated, and the button was pulled
 * from this card rather than shipped pointing at the wrong song; the route that
 * makes it honest exists now, so it is back where the design put it. The waiting
 * rows keep their own "Drop", because removing a request from the queue is a
 * different act on a different song.
 *
 * One click, no confirmation, per the handoff: skipping is a live, expected
 * action a mod already performs from chat with one word.
 *
 * **Skipping early plays one interlude track first.** The bot hands a request to
 * Spotify only in the last ten seconds of the current song, so a skip with time
 * left leaves nothing of ours in Spotify's queue and the player falls through to
 * the streamer's own next track; the request goes over at the end of *that* one.
 * Nothing is lost and the order holds — see `ADVANCE_WINDOW_MS` on the server.
 */

export interface NowPlayingCardProps {
    playing: NowPlaying | null;
    onSkip: () => void;
    /** True while a skip is in flight, so a double click cannot skip twice. */
    skipping?: boolean;
}

export function NowPlayingCard({
    playing,
    onSkip,
    skipping = false
}: NowPlayingCardProps): React.JSX.Element {
    if (!playing) {
        return (
            <section className="card now-playing now-playing--idle">
                <span className="now-playing__art" aria-hidden="true">
                    <Music size={18} />
                </span>
                <span className="now-playing__stack">
                    <span className="now-playing__label">PLAYING IN SPOTIFY</span>
                    <span className="now-playing__idle-copy">
                        Nothing playing. Start something in Spotify and the queue takes over from there.
                    </span>
                </span>
            </section>
        );
    }

    const progress = trackProgress(playing.progressMs, playing.durationMs);

    return (
        <section className="card now-playing">
            {playing.albumArtUrl
                ? <img className="now-playing__art" src={playing.albumArtUrl} alt="" />
                : <span className="now-playing__art" aria-hidden="true" />}

            <span className="now-playing__stack">
                <span className="now-playing__label">PLAYING IN SPOTIFY</span>
                <span className="now-playing__track">{playing.trackName}</span>
                <span className="now-playing__artist">
                    {playing.artistName}
                    {/* Only when the track came from the queue. Most of a stream
                        is the streamer's own listening, and attributing that to
                        the last requester would be a lie about who asked. */}
                    {playing.requestedByLogin ? ` · ${playing.requestedByLogin}` : ''}
                </span>
            </span>

            <span className="now-playing__right">
                <span className="now-playing__time">
                    {formatTrackTime(playing.progressMs)} / {formatTrackTime(playing.durationMs)}
                </span>
                {/* A paused player keeps its track and its position; the bar below
                    simply stops moving. Said out loud, because a frozen bar with
                    no explanation reads as a stalled app. */}
                {!playing.isPlaying && <span className="now-playing__paused">paused</span>}
                <button
                    type="button"
                    className="button button--ghost"
                    aria-label={`Skip ${playing.trackName}`}
                    disabled={skipping}
                    onClick={onSkip}
                >
                    Skip
                </button>
            </span>

            <span className="now-playing__progress" aria-hidden="true">
                <span
                    className="now-playing__progress-fill"
                    style={{ width: `${(progress * 100).toFixed(2)}%` }}
                />
            </span>
        </section>
    );
}
