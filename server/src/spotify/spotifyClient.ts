import type { Logger } from '../logger.js';
import { TwitchError } from '../twitch/errors.js';

/**
 * Spotify Web API client.
 *
 * ## Why a thin fetch client rather than `@spotify/web-api-ts-sdk`
 *
 * Evaluated against our five needs (track lookup, queue add, playback state,
 * skip, playlist add) before writing a line:
 *
 *  - **It does not support our auth flow.** The SDK ships PKCE, client
 *    credentials, and a mixed client/server hand-back. We use server-side
 *    authorization-code *with a secret* (the same shape as our Twitch
 *    onboarding), which is not among them.
 *  - **It refreshes tokens internally.** We already have a token model:
 *    encrypted at rest, rotated atomically, with a distinct
 *    manual-reauth error. Two refresh mechanisms in one process is a real
 *    hazard. The SDK could rotate a refresh token we then overwrite from our
 *    own stored copy, stranding the channel. The docs do not describe
 *    disabling it.
 *  - **1.6 MB unpacked for five endpoints**, last published a year ago with no
 *    stated maintenance status.
 *
 * The honest counter-argument: if we later needed twenty endpoints, or Spotify
 * changed response shapes often, the SDK's maintained types would earn their
 * keep. At five calls they do not, and staying consistent with how we talk to
 * Twitch is worth more.
 *
 * ## Verified against the February 2026 platform changes
 *
 * Spotify removed fifteen endpoints and renamed others in Feb/Mar 2026. Each of
 * our five calls was checked against the migration guide and changelog:
 *
 *   GET  /tracks/{id}          unaffected (the individual fetch that REPLACED
 *                              the removed batch "Get Several Tracks")
 *   GET  /search               available; limit max cut 50 -> 10, default 20 -> 5.
 *                              Irrelevant here: we ask for limit=1, and links
 *                              resolve by id without searching at all.
 *   GET  /me/player            unaffected
 *   POST /me/player/queue      unaffected
 *   POST /me/player/next       unaffected
 *   POST /playlists/{id}/items RENAMED from /tracks. The old path is among the
 *                              removed endpoints, so the obvious spelling would
 *                              404 in production.
 *
 * ## Response bodies are declared per call, not guessed
 *
 * The path check above is only half the verification. A call can hit the right
 * URL and still be read wrong. `POST /me/player/queue` answers 2xx with no JSON
 * body, so demanding parseable JSON from every response would read that success
 * as a failure, and a monitor that believes a queued track was never queued
 * re-queues it on every tick.
 *
 * So each call now declares what it returns, and a body is parsed only where
 * one is used:
 *
 *   GET  /tracks/{id}          json    the track
 *   GET  /search               json    the results
 *   GET  /me/player            json    playback state, or 204 when idle
 *   POST /me/player/queue      none    2xx, no usable body
 *   POST /me/player/next       none    2xx, no usable body
 *   POST /playlists/{id}/items none    returns a snapshot_id we do not read
 *
 * `none` means the status IS the result: any 2xx is success and the body is
 * never touched. That is not laxness. Demanding a shape from a body we never
 * read invents a failure mode with nothing on the other side of it.
 *
 * We operate in **Development Mode**: the app owner must hold Spotify Premium,
 * and every user is allowlisted in the dashboard (5 per app). Any additional
 * broadcaster must be added there before their connect flow can succeed.
 */

const API_BASE = 'https://api.spotify.com/v1';

/** Spotify's own maximum for `/me/playlists`. */
const PLAYLIST_PAGE_SIZE = 50;
/** See `findPlaylistByName`: a bound with a visible, fixable failure mode. */
const MAX_PLAYLIST_PAGES = 10;

export interface SpotifyTrack {
    uri: string;
    id: string;
    name: string;
    artist: string;
    durationMs: number;
}

export interface PlaybackState {
    isPlaying: boolean;
    trackUri: string | null;
    progressMs: number;
    durationMs: number;
    /*
     * The three fields the now-playing card renders. Added with that card, not
     * before it: the monitor only ever needed the uri and the clock, and a
     * payload carrying names nothing read would have been a shape to keep
     * right for no reader.
     */
    trackName: string | null;
    artistName: string | null;
    /** Largest available cover, or null when Spotify offers none. */
    albumArtUrl: string | null;
}

/** A playlist as Spotify holds it, for the settings screen's playlist card. */
export interface SpotifyPlaylistInfo {
    id: string;
    name: string;
    trackCount: number;
}

export class SpotifyError extends TwitchError {
    readonly status: number;

    constructor(endpoint: string, status: number, message: string) {
        super(`Spotify ${endpoint} failed with ${status}: ${message || 'no message'}`);
        this.name = 'SpotifyError';
        this.status = status;
    }
}

export interface SpotifyClientOptions {
    /** Supplies a valid access token, refreshing if needed. */
    accessToken: () => Promise<string>;
    logger: Logger;
    fetchImpl?: typeof fetch;
}

/** Recognizes the shapes a viewer actually pastes. */
const TRACK_URI = /^spotify:track:([A-Za-z0-9]+)$/;
const TRACK_URL = /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/;

/** @returns the track id from a URI or URL, or null when it is neither. */
export function parseTrackId(input: string): string | null {
    const trimmed = input.trim();

    const uri = TRACK_URI.exec(trimmed);
    if (uri?.[1]) return uri[1];

    // Handles the localised links Spotify hands out (open.spotify.com/intl-de/track/...)
    const url = TRACK_URL.exec(trimmed);
    if (url?.[1]) return url[1];

    return null;
}

export interface SpotifyClient {
    getTrack: (id: string) => Promise<SpotifyTrack | null>;
    searchTrack: (query: string) => Promise<SpotifyTrack | null>;
    getPlaybackState: () => Promise<PlaybackState | null>;
    queueTrack: (uri: string) => Promise<void>;
    skipTrack: () => Promise<void>;
    addToPlaylist: (playlistId: string, uri: string) => Promise<void>;
    /** The linked account's display name, for the Spotify card. */
    getCurrentUser: () => Promise<{ id: string; displayName: string } | null>;
    /** @returns null when the playlist no longer exists (a deletion in the Spotify app). */
    getPlaylist: (playlistId: string) => Promise<SpotifyPlaylistInfo | null>;
    /** Creates a private playlist owned by the linked account. */
    createPlaylist: (userId: string, name: string) => Promise<SpotifyPlaylistInfo>;
    /** @returns the account's own playlist with this name, or null. Case-insensitive. */
    findPlaylistByName: (name: string) => Promise<SpotifyPlaylistInfo | null>;
}

export class HttpSpotifyClient implements SpotifyClient {
    private readonly options: SpotifyClientOptions;
    private readonly fetchImpl: typeof fetch;

    constructor(options: SpotifyClientOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async getTrack(id: string): Promise<SpotifyTrack | null> {
        const track = await this.request<SpotifyTrackResponse | null>(`/tracks/${encodeURIComponent(id)}`);
        return track ? toTrack(track) : null;
    }

    async searchTrack(query: string): Promise<SpotifyTrack | null> {
        // limit=1 sits well inside the post-February-2026 maximum of 10.
        const response = await this.request<{ tracks?: { items?: SpotifyTrackResponse[] } }>(
            `/search?q=${encodeURIComponent(query)}&type=track&limit=1`
        );

        const first = response?.tracks?.items?.[0];
        return first ? toTrack(first) : null;
    }

    /**
     * @returns null when nothing is playing at all. Spotify answers 204 with an
     * empty body, which is a state rather than an error.
     */
    async getPlaybackState(): Promise<PlaybackState | null> {
        const state = await this.request<{
            is_playing?: boolean;
            progress_ms?: number;
            item?: {
                uri?: string;
                name?: string;
                duration_ms?: number;
                artists?: { name?: string }[];
                album?: { images?: { url?: string; width?: number }[] };
            } | null;
        } | null>('/me/player');

        if (!state) return null;

        const item = state.item ?? null;

        return {
            isPlaying: state.is_playing ?? false,
            trackUri: item?.uri ?? null,
            progressMs: state.progress_ms ?? 0,
            durationMs: item?.duration_ms ?? 0,
            trackName: item?.name ?? null,
            artistName: item
                ? ((item.artists ?? []).map((a) => a.name ?? '').filter(Boolean).join(', ') || null)
                : null,
            albumArtUrl: largestImage(item?.album?.images)
        };
    }

    /** Success is the status alone. Spotify sends no JSON body here. */
    async queueTrack(uri: string): Promise<void> {
        await this.request(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
            method: 'POST',
            expects: 'none'
        });
    }

    async skipTrack(): Promise<void> {
        await this.request('/me/player/next', { method: 'POST', expects: 'none' });
    }

    async getCurrentUser(): Promise<{ id: string; displayName: string } | null> {
        const me = await this.request<{ id?: string; display_name?: string | null } | null>('/me');
        if (!me?.id) return null;

        // Spotify allows an account with no display name. Falling back to the
        // id keeps the card from rendering an empty line where a name goes.
        return { id: me.id, displayName: me.display_name ?? me.id };
    }

    async getPlaylist(playlistId: string): Promise<SpotifyPlaylistInfo | null> {
        /*
         * `fields` keeps this to what the card shows. A requests playlist grows
         * without bound, and the default response embeds the first hundred
         * tracks, a payload that would grow all season for a name and a count.
         */
        const playlist = await this.request<{
            id?: string; name?: string; tracks?: { total?: number };
        } | null>(
            `/playlists/${encodeURIComponent(playlistId)}?fields=id,name,tracks(total)`
        );

        // A 404 arrives here as null: the streamer deleted the playlist in the
        // Spotify app, which is an ordinary thing to have done, not an error.
        if (!playlist?.id) return null;

        return {
            id: playlist.id,
            name: playlist.name ?? 'Untitled playlist',
            trackCount: playlist.tracks?.total ?? 0
        };
    }

    /**
     * Looks for one of the account's playlists by name.
     *
     * Paged, and **bounded**. `MAX_PLAYLIST_PAGES` pages of fifty is 500
     * playlists; past that this answers null and the caller creates a new one.
     * Stated rather than hidden: an unbounded walk of somebody's library on a
     * settings save is a request that can take a minute, and the failure mode
     * of the bound (a duplicate playlist for a streamer with 500+ of them) is
     * visible and fixable, where a hung save is neither.
     *
     * Matched case-insensitively, because "Song Requests" and "song requests"
     * are the same playlist to the person who named it.
     */
    async findPlaylistByName(name: string): Promise<SpotifyPlaylistInfo | null> {
        const wanted = name.trim().toLowerCase();

        for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
            const response = await this.request<{
                items?: { id?: string; name?: string; tracks?: { total?: number } }[];
                next?: string | null;
            } | null>(`/me/playlists?limit=${PLAYLIST_PAGE_SIZE}&offset=${page * PLAYLIST_PAGE_SIZE}`);

            const items = response?.items ?? [];
            for (const item of items) {
                if (!item.id) continue;
                if ((item.name ?? '').trim().toLowerCase() !== wanted) continue;
                return { id: item.id, name: item.name ?? name, trackCount: item.tracks?.total ?? 0 };
            }

            if (!response?.next) return null;
        }

        this.options.logger.warn(
            { name },
            'Gave up looking for an existing playlist after the page bound - a new one will be created'
        );
        return null;
    }

    async createPlaylist(userId: string, name: string): Promise<SpotifyPlaylistInfo> {
        const created = await this.request<{ id?: string; name?: string; tracks?: { total?: number } }>(
            `/users/${encodeURIComponent(userId)}/playlists`,
            {
                method: 'POST',
                // Private by default: this is the streamer's library, and a
                // public playlist appearing on their profile is not something
                // naming a playlist in our settings screen should decide.
                body: { name, public: false, description: 'Song requests from chat' }
            }
        );

        if (!created?.id) {
            throw new SpotifyError('/users/{id}/playlists', 200, 'create returned no playlist id');
        }

        return { id: created.id, name: created.name ?? name, trackCount: created.tracks?.total ?? 0 };
    }

    /** `/items`, not `/tracks`. Spotify removed the old path in February 2026. */
    async addToPlaylist(playlistId: string, uri: string): Promise<void> {
        await this.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
            method: 'POST',
            body: { uris: [uri] },
            // Answers with a snapshot_id. We do not read it, so we do not
            // require it to arrive or to parse.
            expects: 'none'
        });
    }

    private async request<T>(
        path: string,
        options: { method?: string; body?: unknown; expects?: 'json' | 'none' } = {}
    ): Promise<T> {
        const token = await this.options.accessToken();

        const response = await this.fetchImpl(`${API_BASE}${path}`, {
            method: options.method ?? 'GET',
            headers: {
                authorization: `Bearer ${token}`,
                ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
        });

        const expects = options.expects ?? 'json';

        // 204 means "nothing playing" on the player endpoints and "accepted"
        // on the write ones. Either way there is no body to parse.
        if (response.status === 204) return null as T;

        if (response.status === 404 && expects === 'json') {
            /*
             * Spotify uses 404 for "no active device", which is an ordinary
             * state for a streamer whose Spotify is closed - not a failure to
             * shout about.
             *
             * Reads only. On a write, 404 means the write did not happen, and
             * reporting that as success would let the monitor drop a track it
             * never queued. That is the worse direction, because a lost song
             * is not visible in any log.
             */
            this.options.logger.debug({ path }, 'Spotify reports no active device');
            return null as T;
        }

        // Read unconditionally: even a discarded body is what makes a failure
        // legible in the error message.
        const raw = await response.text();

        if (!response.ok) {
            throw new SpotifyError(path, response.status, extractMessage(raw));
        }

        /*
         * The status IS the result for these. Spotify answers the queue-add and
         * skip endpoints with a 2xx and no JSON, so parsing here would turn
         * every success into a thrown failure and every queued track into a
         * repeat.
         */
        if (expects === 'none') return null as T;

        if (raw.trim() === '') return null as T;

        try {
            return JSON.parse(raw) as T;
        } catch {
            throw new SpotifyError(path, response.status, 'response was not valid JSON');
        }
    }
}

interface SpotifyTrackResponse {
    uri?: string;
    id?: string;
    name?: string;
    duration_ms?: number;
    artists?: { name?: string }[];
}

function toTrack(track: SpotifyTrackResponse): SpotifyTrack {
    return {
        uri: track.uri ?? '',
        id: track.id ?? '',
        name: track.name ?? 'Unknown track',
        // Joined rather than first-only: a collaboration listing one artist
        // reads as wrong to the person who requested it.
        artist: (track.artists ?? []).map((a) => a.name ?? '').filter(Boolean).join(', ') || 'Unknown artist',
        durationMs: track.duration_ms ?? 0
    };
}

/**
 * Spotify returns album art largest-first, but says so in documentation rather
 * than in the payload, so this picks by width instead of trusting the order.
 * A 62px card would rather scale one down than up.
 */
function largestImage(images: { url?: string; width?: number }[] | undefined): string | null {
    let best: { url: string; width: number } | null = null;

    for (const image of images ?? []) {
        if (!image.url) continue;
        const width = image.width ?? 0;
        if (!best || width > best.width) best = { url: image.url, width };
    }

    return best?.url ?? null;
}

function extractMessage(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
        if (typeof parsed.error === 'string') return parsed.error;
        return parsed.error?.message ?? '';
    } catch {
        return raw.slice(0, 200);
    }
}
