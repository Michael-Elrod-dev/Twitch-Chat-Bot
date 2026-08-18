import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSettings, NowPlaying, QueuedSong, SpotifyStatus } from '@almosthadai/shared';
import { memorySessionStorage } from '../auth/sessionStore.js';
import { Songs } from './Songs.js';
import { formatShortDate, formatTrackTime, formatWaiting, trackProgress } from './songsFormat.js';
import { PLAYING_POLL_MS, useAdvancingProgress } from './useAdvancingProgress.js';

/**
 * The songs screen, against a stubbed network.
 *
 * The seam stubbed is the network and nothing else — every hook, component and
 * formatter between the click and the request is the production path, which is
 * the same rule the content screens' suite follows and the reason its
 * optimistic-rollback assertions are worth making.
 *
 * The two things asserted hardest are the two the design is most opinionated
 * about: **there is no add button anywhere**, and **the removal control sits only
 * where the API can act**.
 */

const session = () => memorySessionStorage({ accessToken: 'token', refreshToken: 'r' });

const settings = (over: Partial<ChannelSettings> = {}): ChannelSettings => ({
    aiEnabled: true,
    aiLimits: { everyone: 3, vip: 5, subscriber: 5, moderator: 10 },
    songRequestsEnabled: true,
    requestsPlaylistEnabled: false,
    requestsPlaylistName: null,
    discordWebhookConfigured: false,
    spotifyConnected: true,
    ...over
});

const connected = (over: Partial<SpotifyStatus> = {}): SpotifyStatus => ({
    connected: true,
    accountName: 'michael',
    connectedSince: '2026-08-04T10:00:00.000Z',
    playlist: null,
    ...over
});

const DISCONNECTED: SpotifyStatus = {
    connected: false, accountName: null, connectedSince: null, playlist: null
};

const song = (over: Partial<QueuedSong> = {}): QueuedSong => ({
    id: 'q1',
    trackUri: 'spotify:track:1',
    trackName: 'Sequoia',
    artistName: 'Sylvan Esso',
    requestedByLogin: 'tallgrass',
    // Two minutes ago, which the WHEN column must render as such rather than as
    // a timestamp.
    createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...over
});

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Api { calls: { method: string; url: string }[] }

function stubApi(routes: {
    spotify?: SpotifyStatus;
    playing?: NowPlaying | null;
    onWrite?: (method: string, url: string) => Response;
}): Api {
    const calls: Api['calls'] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        /*
         * Recorded BEFORE the reads are answered, and that ordering is the whole
         * point.
         *
         * This stub used to push only after the GET branch had returned, so reads
         * were never recorded at all — and the tests below, which count how often
         * the page re-reads what is playing, were asserting against a list that
         * could only ever be empty. They failed loudly rather than passing
         * vacuously, but only because they assert a count GOES UP; a test phrased
         * as "no unexpected requests" would have been green against a harness that
         * recorded nothing. The same lesson as the frozen-transition phantom, from
         * the other side: the harness has to be right about what it observes.
         */
        calls.push({ method, url });

        if (method === 'GET') {
            // Before `/songs`, or the playing route matches the queue's prefix.
            if (url.includes('/songs/playing')) return json({ ok: true, data: routes.playing ?? null });
            if (url.includes('/spotify')) return json({ ok: true, data: routes.spotify ?? DISCONNECTED });
        }

        return routes.onWrite?.(method, url) ?? new Response(null, { status: 204 });
    }));

    return { calls };
}

const renderSongs = (props: {
    spotify?: SpotifyStatus;
    playing?: NowPlaying | null;
    queue?: QueuedSong[];
    queueRevision?: number;
    settings?: ChannelSettings | null;
    onQueueChanged?: () => void;
    onSettingsChange?: (patch: unknown) => Promise<string | null>;
    onConnectSpotify?: () => void;
} = {}): Api & { rerenderWith: (next: { queue?: QueuedSong[]; queueRevision: number }) => void } => {
    const api = stubApi({
        ...(props.spotify ? { spotify: props.spotify } : {}),
        ...(props.playing === undefined ? {} : { playing: props.playing })
    });

    const element = (over: { queue?: QueuedSong[]; queueRevision: number }): React.JSX.Element => (
        <Songs
            storage={session()}
            settings={props.settings === undefined ? settings() : props.settings}
            queue={over.queue ?? props.queue ?? []}
            queueRevision={over.queueRevision}
            onQueueChanged={props.onQueueChanged ?? (() => undefined)}
            onSettingsChange={props.onSettingsChange ?? (async () => null)}
            onConnectSpotify={props.onConnectSpotify ?? (() => undefined)}
        />
    );

    const view = render(element({ queueRevision: props.queueRevision ?? 0 }));

    return {
        ...api,
        rerenderWith: (next) => { view.rerender(element(next)); }
    };
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/**
 * A tiny harness for `useAdvancingProgress`.
 *
 * The hook is rendered inside a real component rather than called directly,
 * because its whole behavior is timers and effects — a plain call would test
 * arithmetic that nothing runs. Written here rather than pulling in a
 * render-hook helper the project does not otherwise use.
 */
function renderHookish(initial: NowPlaying): {
    result: () => NowPlaying;
    rerender: () => void;
    setSource: (next: NowPlaying) => void;
} {
    vi.useFakeTimers();

    let source = initial;
    let latest: NowPlaying | null = null;

    function Probe(): null {
        latest = useAdvancingProgress(source);
        return null;
    }

    const view = render(<Probe />);
    return {
        result: () => latest as NowPlaying,
        rerender: () => { act(() => { view.rerender(<Probe />); }); },
        setSource: (next) => { source = next; }
    };
}

// ---- the formatters --------------------------------------------------------

describe('the songs formatters', () => {
    it('writes a track time as m:ss, flooring rather than rounding', () => {
        expect(formatTrackTime(94_000)).toBe('1:34');
        expect(formatTrackTime(243_000)).toBe('4:03');
        // Floors: a readout that reached 4:03 before the track ended would be
        // claiming the song is over.
        expect(formatTrackTime(243_999)).toBe('4:03');
        expect(formatTrackTime(9_000)).toBe('0:09');
        expect(formatTrackTime(0)).toBe('0:00');
    });

    it('survives a nonsense duration rather than rendering NaN', () => {
        expect(formatTrackTime(Number.NaN)).toBe('0:00');
        expect(formatTrackTime(-5_000)).toBe('0:00');
    });

    it('clamps the progress bar at both ends', () => {
        expect(trackProgress(50, 100)).toBe(0.5);
        // Spotify can report a position past the duration during a track change.
        expect(trackProgress(120, 100)).toBe(1);
        expect(trackProgress(-1, 100)).toBe(0);
        // A zero duration is a division by zero, not an empty bar by accident.
        expect(trackProgress(10, 0)).toBe(0);
    });

    it('says "just now" rather than putting a request in the future', () => {
        const now = new Date('2026-08-17T12:00:00.000Z');
        // A client clock a few seconds behind the server's makes this negative.
        expect(formatWaiting('2026-08-17T12:00:05.000Z', now)).toBe('just now');
        expect(formatWaiting('2026-08-17T11:58:00.000Z', now)).toBe('2 min ago');
        expect(formatWaiting('2026-08-17T11:00:00.000Z', now)).toBe('1 hr ago');
        expect(formatWaiting('2026-08-17T09:00:00.000Z', now)).toBe('3 hrs ago');
    });

    it('writes the Spotify "since" date day-first, not by the machine locale', () => {
        // The design draws `since 4 Aug`; a US default renders `Aug 4`, which is
        // a different design.
        expect(formatShortDate('2026-08-04T10:00:00.000Z')).toBe('4 Aug');
        expect(formatShortDate(null)).toBeNull();
        expect(formatShortDate('not a date')).toBeNull();
    });
});

// ---- 3c --------------------------------------------------------------------

describe('Songs (3c)', () => {
    it('has no add button anywhere, and says why instead', async () => {
        // The screen's central argument. A track with no points behind it is not
        // a request, so the absence is explained rather than apologized for.
        renderSongs({ spotify: connected(), queue: [song()] });

        expect(await screen.findByText('HOW SONGS GET HERE')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();
        expect(screen.getByText(/no add button on purpose/)).toBeInTheDocument();
    });

    it('renders the two-stage labels and nothing extra between them', async () => {
        renderSongs({
            spotify: connected(),
            queue: [song()],
            playing: {
                trackName: 'Midnight City',
                artistName: 'M83',
                albumArtUrl: null,
                progressMs: 94_000,
                durationMs: 243_000,
                isPlaying: true,
                requestedByLogin: 'clipzilla'
            }
        });

        expect(await screen.findByText('PLAYING IN SPOTIFY')).toBeInTheDocument();
        expect(screen.getByText('Waiting in the bot')).toBeInTheDocument();
        expect(screen.getByText('hands off as the track ends')).toBeInTheDocument();
        /*
         * The position half is a regex and the duration half is exact.
         *
         * The local progress clock advances the readout while the test runs —
         * that is the card working, not drifting — so pinning the elapsed side to
         * a literal makes this test fail on a slow machine for a reason that has
         * nothing to do with what it is testing. The shape and the duration are
         * what this assertion is actually about; `formatTrackTime` has its own
         * exact tests above.
         */
        expect(screen.getByText(/^\d+:\d\d \/ 4:03$/)).toBeInTheDocument();
        expect(screen.getByText('M83 · clipzilla')).toBeInTheDocument();
    });

    it('keeps the track and says "paused" rather than blanking the card', async () => {
        renderSongs({
            spotify: connected(),
            playing: {
                trackName: 'Midnight City',
                artistName: 'M83',
                albumArtUrl: null,
                progressMs: 94_000,
                durationMs: 243_000,
                isPlaying: false,
                requestedByLogin: null
            }
        });

        expect(await screen.findByText('Midnight City')).toBeInTheDocument();
        expect(screen.getByText('paused')).toBeInTheDocument();
        // No requester on a track the streamer started themselves — attributing
        // it to the last redeemer would be a lie about who asked.
        expect(screen.getByText('M83')).toBeInTheDocument();
    });

    it('treats nothing playing as an ordinary state, not an empty one', async () => {
        renderSongs({ spotify: connected(), playing: null, queue: [song()] });

        expect(await screen.findByText(/Nothing playing/)).toBeInTheDocument();
        // The label survives, because the label is what explains the queue.
        expect(screen.getByText('PLAYING IN SPOTIFY')).toBeInTheDocument();
    });

    it('skips the PLAYING track and never touches the queue route', async () => {
        /*
         * The two controls act on two different songs, and this is the assertion
         * that keeps them apart. Skip beside the now-playing card must reach
         * `POST /songs/skip`; if it ever reaches `DELETE /songs/head` it silently
         * removes a viewer's waiting request while the streamer believes they
         * skipped what they were listening to — the exact confusion this screen
         * was briefly built around.
         */
        const api = renderSongs({
            spotify: connected(),
            queue: [song()],
            playing: {
                trackName: 'Midnight City', artistName: 'M83', albumArtUrl: null,
                progressMs: 94_000, durationMs: 243_000, isPlaying: true, requestedByLogin: null
            }
        });

        await userEvent.click(await screen.findByRole('button', { name: 'Skip Midnight City' }));

        await waitFor(() => {
            expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/songs/skip'))).toBe(true);
        });
        expect(api.calls.some((c) => c.url.includes('/songs/head'))).toBe(false);
    });

    it('keeps Skip and Drop as separate controls naming separate songs', async () => {
        renderSongs({
            spotify: connected(),
            queue: [song()],
            playing: {
                trackName: 'Midnight City', artistName: 'M83', albumArtUrl: null,
                progressMs: 94_000, durationMs: 243_000, isPlaying: true, requestedByLogin: null
            }
        });

        // Each label names the track it acts on, so neither can be read as the
        // other.
        expect(await screen.findByRole('button', { name: 'Skip Midnight City' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Drop Sequoia from the queue' })).toBeInTheDocument();
    });

    it('offers the removal control on the head row and no other', async () => {
        /*
         * `DELETE /songs/head` is the only removal the API has. An `x` on row two
         * that quietly removed row one would be the worst kind of working button,
         * so the control exists exactly where it can act.
         */
        renderSongs({
            spotify: connected(),
            queue: [song(), song({ id: 'q2', trackName: 'Nightcall', requestedByLogin: 'pixelrat' })]
        });

        expect(await screen.findByRole('button', { name: 'Drop Sequoia from the queue' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Drop Nightcall from the queue' })).not.toBeInTheDocument();
    });

    it('drops the head with one click and no confirmation', async () => {
        // A live, expected action a mod does from chat with one word. A dialog
        // between the streamer and it would be ceremony.
        const changed = vi.fn();
        const api = renderSongs({ spotify: connected(), queue: [song()], onQueueChanged: changed });

        await userEvent.click(await screen.findByRole('button', { name: 'Drop Sequoia from the queue' }));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        await waitFor(() => {
            expect(api.calls.some((c) => c.method === 'DELETE' && c.url.includes('/songs/head'))).toBe(true);
        });
        // The shell owns the queue, so the screen asks it to re-read rather than
        // editing a list it does not hold.
        await waitFor(() => { expect(changed).toHaveBeenCalled(); });
    });

    it('does not banner an empty-queue 404 — the queue is already where the click asked', async () => {
        renderSongs({
            spotify: connected(),
            queue: [song()],
            playing: null
        });
        // The stub answers 204 by default; this asserts the reasoning holds for
        // the 404 shape too, through the same path.
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if ((init?.method ?? 'GET') === 'GET') {
                if (url.includes('/songs/playing')) return json({ ok: true, data: null });
                if (url.includes('/spotify')) return json({ ok: true, data: connected() });
            }
            return json({ ok: false, error: { code: 'not_found', message: 'The queue is empty' } }, 404);
        }));

        await userEvent.click(await screen.findByRole('button', { name: 'Drop Sequoia from the queue' }));

        await waitFor(() => {
            expect(screen.queryByText('The queue is empty')).not.toBeInTheDocument();
        });
    });

    it('shows the playlist track count from Spotify, not from the name typed', async () => {
        renderSongs({
            spotify: connected({ playlist: { id: 'p1', name: 'Stream Requests', trackCount: 312 } }),
            settings: settings({ requestsPlaylistEnabled: true, requestsPlaylistName: 'Stream Requests' })
        });

        expect(await screen.findByText('312 tracks in it')).toBeInTheDocument();
    });

    it('says the playlist is not made yet rather than reporting a count for a missing one', async () => {
        // Named but not created is an ordinary state: the bot makes it with the
        // first request. A count here would describe a playlist that is not there.
        renderSongs({
            spotify: connected({ playlist: null }),
            settings: settings({ requestsPlaylistEnabled: true, requestsPlaylistName: 'Stream Requests' })
        });

        expect(await screen.findByText(/Not made yet/)).toBeInTheDocument();
        expect(screen.queryByText(/tracks in it/)).not.toBeInTheDocument();
    });

    it('reports the requests-toggle partial failure inline, not as a toast', async () => {
        // The handoff asks for this by name: the setting saved but Twitch would
        // not hide the reward. It is a fact about that row.
        const onSettingsChange = vi.fn(async () => 'Saved, but the Twitch reward is still visible');
        renderSongs({ spotify: connected(), onSettingsChange });

        await userEvent.click(await screen.findByRole('switch', { name: 'Let viewers request songs' }));

        expect(await screen.findByText('Saved, but the Twitch reward is still visible')).toBeInTheDocument();
    });
});

// ---- living without a navigation -------------------------------------------

describe('the songs page updates without being navigated away from', () => {
    /**
     * The owner's second report, and the half of it that lived in the client.
     *
     * The queue rows arrive through the shell's socket, but the now-playing card
     * fetched once on mount and never again — so the page appeared to update only
     * on navigate-away-and-back, because a remount was the only thing that
     * refetched it. These pin the two triggers that replaced that.
     */
    it('re-reads what is playing when the queue moves', async () => {
        const api = renderSongs({
            spotify: connected(),
            queue: [song()],
            playing: {
                trackName: 'Midnight City', artistName: 'M83', albumArtUrl: null,
                progressMs: 1_000, durationMs: 243_000, isPlaying: true, requestedByLogin: null
            },
            queueRevision: 0
        });

        await screen.findByText('Midnight City');
        const before = api.calls.filter((c) => c.url.includes('/songs/playing')).length;

        // The bot handed a track over: the queue moved, so the card is stale.
        api.rerenderWith({ queue: [], queueRevision: 1 });

        await waitFor(() => {
            expect(api.calls.filter((c) => c.url.includes('/songs/playing')).length)
                .toBeGreaterThan(before);
        });
    });

    it('polls what is playing while the page is open', async () => {
        vi.useFakeTimers();
        try {
            const api = renderSongs({
                spotify: connected(),
                playing: {
                    trackName: 'Midnight City', artistName: 'M83', albumArtUrl: null,
                    progressMs: 1_000, durationMs: 243_000, isPlaying: true, requestedByLogin: null
                }
            });

            // Let the mount fetches settle before counting.
            await vi.advanceTimersByTimeAsync(50);
            const before = api.calls.filter((c) => c.url.includes('/songs/playing')).length;

            // A streamer skipping inside Spotify is invisible to us; only time
            // passing reveals it.
            await vi.advanceTimersByTimeAsync(PLAYING_POLL_MS + 100);

            expect(api.calls.filter((c) => c.url.includes('/songs/playing')).length)
                .toBeGreaterThan(before);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not poll when Spotify is not connected', async () => {
        vi.useFakeTimers();
        try {
            const api = renderSongs({ spotify: DISCONNECTED });
            await vi.advanceTimersByTimeAsync(50);
            const before = api.calls.length;

            await vi.advanceTimersByTimeAsync(PLAYING_POLL_MS * 3);

            // Nothing to ask about, so nothing is asked — a disconnected account
            // must not generate a request every fifteen seconds forever.
            expect(api.calls.length).toBe(before);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---- the local progress clock ----------------------------------------------

describe('the now-playing progress clock', () => {
    const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
        trackName: 'Midnight City', artistName: 'M83', albumArtUrl: null,
        progressMs: 60_000, durationMs: 243_000, isPlaying: true, requestedByLogin: null,
        ...over
    });

    it('advances between polls rather than freezing', () => {
        const { result, rerender } = renderHookish(track());
        expect(result().progressMs).toBe(60_000);

        vi.advanceTimersByTime(3_000);
        rerender();

        // Roughly three seconds on, without a request: the position between two
        // facts is arithmetic, not something to ask the server for every second.
        expect(result().progressMs).toBeGreaterThanOrEqual(62_500);
        expect(result().progressMs).toBeLessThanOrEqual(63_500);
    });

    it('does not advance while the player is paused', () => {
        const { result, rerender } = renderHookish(track({ isPlaying: false }));

        vi.advanceTimersByTime(5_000);
        rerender();

        // A frozen bar under a paused player is correct, not a stall.
        expect(result().progressMs).toBe(60_000);
    });

    it('never runs past the end of the track it describes', () => {
        const { result, rerender } = renderHookish(track({ progressMs: 242_000, durationMs: 243_000 }));

        vi.advanceTimersByTime(30_000);
        rerender();

        // Otherwise a track whose end we have not yet polled reads 4:31 / 4:03.
        expect(result().progressMs).toBe(243_000);
    });

    it('lets a poll overrule the local clock, including backwards', () => {
        const { result, rerender, setSource } = renderHookish(track());
        vi.advanceTimersByTime(10_000);
        rerender();
        expect(result().progressMs).toBeGreaterThan(60_000);

        // The streamer scrubbed back. The tick is a guess between two facts; a
        // fact replaces it outright.
        setSource(track({ progressMs: 5_000 }));
        rerender();

        expect(result().progressMs).toBe(5_000);
    });
});

// ---- 4c --------------------------------------------------------------------

describe('Songs with Spotify missing (4c)', () => {
    it('sells the feature instead of reporting a fault', async () => {
        renderSongs({ spotify: DISCONNECTED });

        expect(await screen.findByText('Hook up Spotify and the jukebox opens')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Connect Spotify' })).toBeInTheDocument();
        expect(screen.getByText('The Song Request reward stays switched off until it is connected.'))
            .toBeInTheDocument();
        // Not an error: a streamer who has not linked Spotify has not broken
        // anything, so nothing here is a banner.
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('renders the header toggle inert rather than merely unresponsive', async () => {
        const onSettingsChange = vi.fn(async () => null);
        renderSongs({ spotify: DISCONNECTED, onSettingsChange });

        const toggle = await screen.findByRole('switch', { name: 'Let viewers request songs' });
        expect(toggle).toBeDisabled();

        // And it genuinely cannot be flipped: turning the reward on with nothing
        // behind it would sell viewers a request the bot cannot play.
        await userEvent.click(toggle);
        expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it('omits the waiting count, which would read as an empty queue', async () => {
        renderSongs({ spotify: DISCONNECTED, queue: [] });

        await screen.findByText('Hook up Spotify and the jukebox opens');
        expect(screen.queryByText('0 waiting')).not.toBeInTheDocument();
    });

    it('shows neither the queue nor the policy card — there is no queue to explain', async () => {
        renderSongs({ spotify: DISCONNECTED, queue: [song()] });

        await screen.findByText('Hook up Spotify and the jukebox opens');
        expect(screen.queryByText('Waiting in the bot')).not.toBeInTheDocument();
        expect(screen.queryByText('HOW SONGS GET HERE')).not.toBeInTheDocument();
    });
});
