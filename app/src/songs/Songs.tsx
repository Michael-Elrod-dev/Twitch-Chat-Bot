import { useCallback, useEffect, useState } from 'react';
import { Check, Music, X } from 'lucide-react';
import type {
    ChannelSettings,
    NowPlaying,
    QueuedSong,
    SpotifyStatus
} from '@almosthadai/shared';
import { apiRequest } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { presentError } from '../content/errorPresentation.js';
import { ContentBanner } from '../content/ContentBanner.js';
import { Toggle } from '../controls/Toggle.js';
import { NowPlayingCard } from './NowPlayingCard.js';
import { SpotifyCard } from './SpotifyCard.js';
import { formatWaiting } from './songsFormat.js';
import { PLAYING_POLL_MS, SKIP_SETTLE_MS, useAdvancingProgress } from './useAdvancingProgress.js';
import type { SettingsPatch } from '../settings/settingsPatch.js';

/**
 * Songs (`3c`) and its Spotify-missing state (`4c`).
 *
 * **There is no add button, and its absence is the screen's argument.** Songs
 * arrive by redeeming the reward and no other way, because a track with no points
 * behind it is not a request — so the policy card explains the rule rather than
 * the UI apologising for a missing control. Adding one would also be inventing a
 * capability: no endpoint accepts a track.
 *
 * **Two removals, and they are different songs.** Skip, beside the now-playing
 * card, advances Spotify's player (`POST /songs/skip`). Drop, on the queue's head
 * row, removes the next *waiting* request (`DELETE /songs/head`). Conflating them
 * is the mistake this screen was briefly built around, so the labels and the
 * placement both say which song each one acts on. Drop appears on row one and
 * nowhere else, because the head is the only row the API can remove — an `x` on
 * row four that quietly removed row one would be the worst kind of working button.
 *
 * Both are one click with no confirmation, per the handoff: they are live,
 * expected actions a mod already performs from chat with one word.
 *
 * `4c` is the same screen with nothing to show. It sells the feature instead of
 * erroring, which is the rule for every degraded state here: a streamer who has
 * not linked Spotify has not broken anything.
 */

export interface SongsProps {
    storage: SessionStorage;
    /** From the shell, which already holds `/me`. */
    settings: ChannelSettings | null;
    /** The live queue the shell maintains off `song_queue.updated`. */
    queue: QueuedSong[];
    /**
     * Bumped by the shell every time the queue changes.
     *
     * A counter rather than the array, because the card this drives has to
     * re-read when the queue moves even if the visible rows end up identical —
     * and an array identity check would miss a handoff that emptied a
     * one-song queue back to a one-song queue.
     */
    queueRevision: number;
    /** Re-reads the queue after this screen changes it. */
    onQueueChanged: () => void;
    /**
     * Persists a settings change through the shell, which owns `/me`.
     *
     * @returns null on success, or a message for the caller to place. An empty
     * patch is a re-read: the songs screen needs one after a disconnect, because
     * the server switches requests off with the account and the shell's copy of
     * the settings is stale the moment it does.
     */
    onSettingsChange: (patch: SettingsPatch) => Promise<string | null>;
    /** Starts the Spotify browser chain. */
    onConnectSpotify: () => void;
}

export function Songs({
    storage,
    settings,
    queue,
    queueRevision,
    onQueueChanged,
    onSettingsChange,
    onConnectSpotify
}: SongsProps): React.JSX.Element {
    const spotify = useResource<SpotifyStatus>({ path: '/api/v1/spotify', storage });
    const playing = useResource<NowPlaying>({ path: '/api/v1/songs/playing', storage });

    /*
     * The now-playing card, kept live rather than fetched once.
     *
     * The queue rows arrive through the shell's socket, but this card had no
     * live path at all — so the page only changed when it was unmounted and
     * remounted, which is precisely what the owner described as "updates only on
     * navigate-away-and-back".
     *
     * Two triggers, because the track changes for two different reasons:
     *
     *  - **The queue moved.** A handoff is the bot putting a NEW track into
     *    Spotify, so the moment the queue shrinks is the moment this card is
     *    stale. That is an event, not a guess, and it arrives already.
     *  - **Time passed.** Everything else — the streamer skipping in Spotify, a
     *    track simply ending — is invisible to us, and the card draws a
     *    `1:34 / 4:03` readout that has to advance. So it also polls.
     *
     * The poll is deliberately slow and the progress is advanced locally between
     * polls, which is the uptime clock's arrangement exactly: tick locally,
     * re-sync on the authority. A poll fast enough to animate a progress bar
     * would be a request every second per open app, for a number we can compute.
     */
    const reloadPlaying = playing.reload;

    useEffect(() => {
        if (!spotify.data?.connected) return undefined;

        const handle = setInterval(() => { void reloadPlaying(); }, PLAYING_POLL_MS);
        return () => { clearInterval(handle); };
    }, [spotify.data?.connected, reloadPlaying]);

    // The queue changing means the bot handed something over: re-read at once
    // rather than waiting up to a poll interval to notice.
    useEffect(() => {
        if (queueRevision === 0) return;
        void reloadPlaying();
    }, [queueRevision, reloadPlaying]);

    const nowPlaying = useAdvancingProgress(playing.data);

    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<string | null>(null);
    /**
     * The partial-failure case the handoff asks for by name: the setting saved
     * but Twitch would not hide the reward. Inline on the row rather than a
     * toast, because it is a fact about that switch and a toast would let it
     * scroll away unread.
     */
    const [toggleNotice, setToggleNotice] = useState<string | null>(null);

    const connected = spotify.data?.connected ?? false;
    const requestsEnabled = settings?.songRequestsEnabled ?? false;

    const setRequests = useCallback((next: boolean): void => {
        setToggleNotice(null);
        void (async () => {
            const error = await onSettingsChange({ songRequestsEnabled: next });
            if (error !== null) setToggleNotice(error);
        })();
    }, [onSettingsChange]);

    /**
     * Skips the track playing in Spotify.
     *
     * Followed by a re-read, and then one more a moment later: Spotify's player
     * does not advance synchronously, so an immediate read usually still returns
     * the track just skipped. The second read is what makes the card change
     * within a second rather than at the next poll. Both are cheap, and the poll
     * remains the backstop if Spotify is slower than the delay.
     */
    const skipPlaying = useCallback((): void => {
        setBanner(null);
        setBusy(true);
        void (async () => {
            try {
                await withFreshSession(storage, (accessToken) =>
                    apiRequest('/api/v1/songs/skip', { method: 'POST', accessToken }));
            } catch (error) {
                const presented = presentError(error);
                // Nothing playing is the state the click asked for, not a fault.
                if (presented.code !== 'not_found') setBanner(presented.message);
            } finally {
                setBusy(false);
                await reloadPlaying();
                window.setTimeout(() => { void reloadPlaying(); }, SKIP_SETTLE_MS);
            }
        })();
    }, [storage, reloadPlaying]);

    const dropHead = useCallback((): void => {
        setBanner(null);
        setBusy(true);
        void (async () => {
            try {
                await withFreshSession(storage, (accessToken) =>
                    apiRequest('/api/v1/songs/head', { method: 'DELETE', accessToken }));
            } catch (error) {
                /*
                 * An empty queue answers 404, and that is not worth a banner: the
                 * queue is already in the state the click asked for. The same
                 * already-gone reasoning `useCollection` applies to its deletes.
                 */
                const presented = presentError(error);
                if (presented.code !== 'not_found') setBanner(presented.message);
            } finally {
                setBusy(false);
                onQueueChanged();
            }
        })();
    }, [storage, onQueueChanged]);

    const disconnect = useCallback((): void => {
        setBanner(null);
        setBusy(true);
        void (async () => {
            try {
                await withFreshSession(storage, (accessToken) =>
                    apiRequest('/api/v1/spotify', { method: 'DELETE', accessToken }));
            } catch (error) {
                setBanner(presentError(error).message);
            } finally {
                setBusy(false);
                await spotify.reload();
                // The server switches requests off with the account, so the
                // shell's copy of the settings is now wrong. Re-read rather than
                // guessed — the header pill reads the same field.
                await onSettingsChange({});
            }
        })();
    }, [storage, spotify, onSettingsChange]);

    const header = (
        <header className="content-header">
            <h1 className="content-title">Songs</h1>
            {/* No count in `4c`: there is no queue to count, and "0 waiting"
                would read as an empty queue rather than an absent feature. */}
            {connected && <span className="content-meta">{queue.length} waiting</span>}

            <div className="content-header__spacer" />

            <span className={`requests-pill${requestsEnabled && connected ? '' : ' requests-pill--off'}`}>
                Requests open
                <Toggle
                    on={requestsEnabled}
                    label="Let viewers request songs"
                    // `4c`: inert, not merely unresponsive. Turning the reward on
                    // with no Spotify behind it would let viewers spend points on
                    // a request the bot cannot play.
                    disabled={!connected}
                    onChange={setRequests}
                />
            </span>
        </header>
    );

    // Nothing is drawn under the header until the Spotify read lands: `3c` and
    // `4c` are different pages, and flashing the wrong one for a frame would
    // tell the streamer their account had been unlinked.
    if (spotify.loading) return <div className="content-page">{header}</div>;

    if (!connected) {
        return (
            <div className="content-page">
                {header}
                {spotify.banner && (
                    <ContentBanner message={spotify.banner} onDismiss={spotify.dismissBanner} />
                )}
                <SpotifyMissing onConnect={onConnectSpotify} />
            </div>
        );
    }

    const status = spotify.data as SpotifyStatus;
    const shownBanner = banner ?? spotify.banner;

    return (
        <div className="content-page">
            {header}

            {shownBanner && (
                <ContentBanner
                    message={shownBanner}
                    onDismiss={() => { setBanner(null); spotify.dismissBanner(); }}
                />
            )}
            {toggleNotice && <p className="inline-notice">{toggleNotice}</p>}

            <div className="songs">
                <div className="songs__main">
                    <NowPlayingCard playing={nowPlaying} onSkip={skipPlaying} skipping={busy} />

                    <section className="card list-card songs__queue">
                        <header className="card__header">
                            <h2 className="card__title">Waiting in the bot</h2>
                            {/* With the label above, the entire explanation of the
                                two-stage queue. The design forbids adding prose. */}
                            <span className="card__meta">hands off as the track ends</span>
                        </header>

                        {queue.length === 0
                            ? (
                                <div className="empty-panel">
                                    <span className="empty-panel__glyph" aria-hidden="true">
                                        <Music size={16} />
                                    </span>
                                    <p className="empty-panel__copy">
                                        Empty. Songs land here when someone burns points on the reward.
                                    </p>
                                </div>
                            )
                            : (
                                <>
                                    <div className="list-grid list-grid--queue list-grid__head">
                                        <span>#</span>
                                        <span>TRACK</span>
                                        <span>REQUESTED BY</span>
                                        <span>WHEN</span>
                                        <span />
                                    </div>
                                    {queue.map((song, index) => (
                                        <div className="list-grid list-grid--queue list-row" key={song.id}>
                                            <span className="queue-row__index">{index + 1}</span>
                                            <span className="list-row__stack">
                                                <span className="list-row__track">{song.trackName}</span>
                                                <span className="list-row__artist">{song.artistName}</span>
                                            </span>
                                            <span className="list-row__requester">
                                                {song.requestedByLogin ?? '—'}
                                            </span>
                                            <span className="list-row__when">
                                                {formatWaiting(song.createdAt)}
                                            </span>
                                            <span className="list-row__actions">
                                                {index === 0 && (
                                                    <button
                                                        type="button"
                                                        aria-label={`Drop ${song.trackName} from the queue`}
                                                        disabled={busy}
                                                        onClick={dropHead}
                                                    >
                                                        <X size={15} />
                                                    </button>
                                                )}
                                            </span>
                                        </div>
                                    ))}
                                </>
                            )}
                    </section>
                </div>

                <div className="songs__side">
                    <SpotifyCard status={status} onDisconnect={disconnect} disconnecting={busy} />

                    <section className="card playlist-card">
                        <div className="playlist-card__head">
                            <span className="playlist-card__title">Save requests to a playlist</span>
                            <Toggle
                                on={settings?.requestsPlaylistEnabled ?? false}
                                label="Save requests to a playlist"
                                onChange={(next) => {
                                    void onSettingsChange({ requestsPlaylistEnabled: next });
                                }}
                            />
                        </div>
                        <p className="playlist-card__copy">
                            Every requested track gets added once. Duplicates are skipped.
                        </p>

                        {settings?.requestsPlaylistName
                            ? (
                                <>
                                    <span className="playlist-card__name">
                                        {settings.requestsPlaylistName}
                                    </span>
                                    {/*
                                      * The count comes from Spotify, not from the
                                      * name the streamer typed. Null covers "named
                                      * but not created yet" and "deleted in the
                                      * Spotify app since" — both have nothing to
                                      * count, and neither is an error worth a
                                      * banner over a working bot.
                                      */}
                                    {status.playlist
                                        ? (
                                            <span className="playlist-card__count">
                                                <Check size={14} aria-hidden="true" />
                                                {status.playlist.trackCount} tracks in it
                                            </span>
                                        )
                                        : (
                                            <span className="playlist-card__count playlist-card__count--pending">
                                                Not made yet — the bot creates it with the first request.
                                            </span>
                                        )}
                                </>
                            )
                            : (
                                <span className="playlist-card__count playlist-card__count--pending">
                                    Name one in Settings · Songs.
                                </span>
                            )}
                    </section>

                    <section className="card policy-card">
                        <span className="policy-card__label">HOW SONGS GET HERE</span>
                        <p className="policy-card__copy">
                            Only by redeeming the Song Request reward. There is no add button on
                            purpose — a track with no points behind it is not a request.
                        </p>
                    </section>
                </div>
            </div>
        </div>
    );
}

/** `4c` — one centred column that sells the feature rather than reporting a fault. */
function SpotifyMissing({ onConnect }: { onConnect: () => void }): React.JSX.Element {
    return (
        <section className="spotify-missing">
            <span className="spotify-missing__glyph" aria-hidden="true">
                <Music size={20} />
            </span>
            <h2 className="spotify-missing__headline">Hook up Spotify and the jukebox opens</h2>
            <p className="spotify-missing__copy">
                Viewers spend points, tracks queue up here, and each one slides into your Spotify
                as the last one ends. Nothing else in the app changes.
            </p>
            <button type="button" className="button button--primary" onClick={onConnect}>
                Connect Spotify
            </button>
            <p className="spotify-missing__note">
                The Song Request reward stays switched off until it is connected.
            </p>
        </section>
    );
}
