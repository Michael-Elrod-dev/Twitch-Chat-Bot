const config = require('../../config/config');
const QueueManager = require('./queueManager');
const SpotifyWebApi = require('spotify-web-api-node');
const logger = require('../../logger/logger');

// Spotify access tokens last an hour. Refresh a minute early rather than waiting
// for a 401 in the middle of queueing a song.
const DEFAULT_TOKEN_LIFETIME_MS = 3600000;
const TOKEN_REFRESH_MARGIN_MS = 60000;

class SpotifyManager {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
        this.spotifyApi = new SpotifyWebApi({
            clientId: this.tokenManager.tokens.spotifyClientId,
            clientSecret: this.tokenManager.tokens.spotifyClientSecret,
            redirectUri: 'http://127.0.0.1:3000/callback'
        });

        if (this.tokenManager.tokens.spotifyUserAccessToken) {
            this.spotifyApi.setAccessToken(this.tokenManager.tokens.spotifyUserAccessToken);
            this.spotifyApi.setRefreshToken(this.tokenManager.tokens.spotifyUserRefreshToken);
        }
        this.requestsPlaylistId = null;
        this.queueManager = new QueueManager();
        this.lastPlaybackState = 'NONE';
        this.lastPlayedTrack = null;

        // Monitors are NOT started here. They are owned by start()/stop() so a
        // stream cycle cannot leave a second set of them racing the song queue.
        this.playbackMonitor = null;
        this.lastSongMonitor = null;
        this.queueMonitor = null;

        // null = not yet checked. authenticate() resolves it to true/false.
        this.authValid = null;
        // null = validity unknown, so the next ensureTokenValid() probes.
        this.tokenExpiresAt = null;
    }

    async init(dbManager) {
        await this.queueManager.init(dbManager);
    }

    isMonitoring() {
        return this.playbackMonitor !== null;
    }

    /**
     * Starts the three polling loops. Idempotent: calling it while already running
     * is a no-op, so monitors can never stack across stream cycles.
     */
    start() {
        if (this.authValid === false) {
            logger.warn('SpotifyManager', 'Spotify authorization is dead - monitors NOT started. Re-authorize Spotify to restore song requests.');
            return;
        }

        if (this.isMonitoring()) {
            logger.debug('SpotifyManager', 'Monitors already running, skipping start');
            return;
        }

        this.playbackMonitor = setInterval(() => this.pollPlaybackState(), config.spotifyInterval);
        this.lastSongMonitor = setInterval(() => this.pollLastSong(), config.spotifyInterval);
        this.queueMonitor = setInterval(() => this.advanceQueueIfTrackEnding(), config.spotifyInterval);

        logger.info('SpotifyManager', 'Playback monitors started', {
            intervalMs: config.spotifyInterval
        });
    }

    /** Clears all three loops. Safe to call when already stopped. */
    stop() {
        if (!this.isMonitoring()) {
            logger.debug('SpotifyManager', 'Monitors already stopped, nothing to do');
            return;
        }

        clearInterval(this.playbackMonitor);
        clearInterval(this.lastSongMonitor);
        clearInterval(this.queueMonitor);

        this.playbackMonitor = null;
        this.lastSongMonitor = null;
        this.queueMonitor = null;

        logger.info('SpotifyManager', 'Playback monitors stopped');
    }

    async pollPlaybackState() {
        try {
            this.lastPlaybackState = await this.getPlaybackState();
        } catch (error) {
            logger.error('SpotifyManager', 'Error monitoring playback', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async advanceQueueIfTrackEnding() {
        try {
            await this.ensureTokenValid();
            const currentPlayback = await this.spotifyApi.getMyCurrentPlaybackState();
            const playback = currentPlayback?.body;

            if (!playback || !playback.item) {
                return;
            }

            // Without this gate, pausing a track with <1 interval remaining makes
            // every tick shovel another queued song into Spotify and delete its row.
            if (!playback.is_playing) {
                logger.debug('SpotifyManager', 'Playback paused, not advancing queue');
                return;
            }

            const remaining = playback.item.duration_ms - playback.progress_ms;
            if (remaining >= config.spotifyInterval) {
                return;
            }

            const pendingTracks = await this.queueManager.getPendingTracks();
            if (pendingTracks.length === 0) {
                return;
            }

            const nextTrack = pendingTracks[0];

            await this.spotifyApi.addToQueue(nextTrack.uri);
            logger.debug('SpotifyManager', 'Added next track to Spotify queue', {
                trackName: nextTrack.name,
                artist: nextTrack.artist,
                requestedBy: nextTrack.requestedBy
            });

            await this.queueManager.removeFirstTrack();
            logger.debug('SpotifyManager', 'Removed track from pending queue', {
                trackName: nextTrack.name
            });
        } catch (error) {
            logger.error('SpotifyManager', 'Error monitoring current track', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async pollLastSong() {
        try {
            const state = await this.getPlaybackState();
            if (state === 'CLOSED') {
                return;
            }

            await this.ensureTokenValid();
            const currentTrack = await this.spotifyApi.getMyCurrentPlayingTrack();

            if (currentTrack.body && currentTrack.body.item) {
                if (!this.lastPlayedTrack ||
                    this.lastPlayedTrack.id !== currentTrack.body.item.id) {
                    if (this.lastPlayedTrack) {
                        this.previousTrack = {
                            name: this.lastPlayedTrack.name,
                            artist: this.lastPlayedTrack.artists[0].name
                        };
                    }
                    this.lastPlayedTrack = currentTrack.body.item;
                }
            }
        } catch (error) {
            logger.error('SpotifyManager', 'Error tracking last song', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * @returns {Promise<boolean>} whether Spotify auth is usable. Callers should
     * not start monitors when this is false - they would poll a dead API forever.
     */
    async authenticate() {
        try {
            if (!this.tokenManager.tokens.spotifyUserAccessToken) {
                logger.warn('SpotifyManager', 'No Spotify user token configured');
                this.authValid = false;
                return false;
            }

            try {
                await this.spotifyApi.getMe();
                logger.info('SpotifyManager', 'Existing Spotify user auth valid');
                this.authValid = true;
                return true;
            } catch (error) {
                try {
                    const data = await this.spotifyApi.refreshAccessToken();
                    this.spotifyApi.setAccessToken(data.body['access_token']);
                    this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                    await this.tokenManager.saveTokens();
                    logger.info('SpotifyManager', 'Spotify token refreshed successfully');
                    this.authValid = true;
                    return true;
                } catch (refreshError) {
                    logger.error('SpotifyManager', 'SPOTIFY RE-AUTHORIZATION REQUIRED - refresh failed, song features are disabled', {
                        error: refreshError.message
                    });
                    this.authValid = false;
                    return false;
                }
            }
        } catch (error) {
            logger.error('SpotifyManager', 'Spotify authentication error', {
                error: error.message,
                stack: error.stack
            });
            this.authValid = false;
            return false;
        }
    }

    async getPlaybackState() {
        try {
            await this.ensureTokenValid();
            const state = await this.spotifyApi.getMyCurrentPlaybackState();
            if (!state.body || !state.body.device) {
                return 'CLOSED';
            }

            return state.body.is_playing ? 'PLAYING' : 'PAUSED';
        } catch (error) {
            return 'CLOSED';
        }
    }

    async addToQueue(trackUri) {
        try {
            await this.ensureTokenValid();
            await this.spotifyApi.addToQueue(trackUri);
            return true;
        } catch (error) {
            if (error.body?.error?.reason !== 'NO_ACTIVE_DEVICE') {
                logger.error('SpotifyManager', 'Error adding to queue', {
                    error: error.message,
                    stack: error.stack
                });
            }
            throw error;
        }
    }

    /**
     * Keeps the Spotify access token current. Validity is tracked by timestamp:
     * this runs on every poll tick of three loops, and the old getMe() probe meant
     * an extra Spotify API call each time just to ask "still valid?". Refresh is
     * driven by the known expiry, with a 401 from real traffic as the backstop.
     */
    async ensureTokenValid() {
        if (this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
            return;
        }

        try {
            await this.spotifyApi.getMe();
            // Unknown real expiry; assume Spotify's standard hour and let the 401
            // path correct us if that is ever wrong.
            this.tokenExpiresAt = Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
        } catch (error) {
            if (error.statusCode === 401) {
                await this.refreshAccessToken();
            } else {
                throw error;
            }
        }
    }

    async refreshAccessToken() {
        try {
            const data = await this.spotifyApi.refreshAccessToken();
            this.spotifyApi.setAccessToken(data.body['access_token']);
            this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
            await this.tokenManager.saveTokens();

            const lifetimeMs = (data.body['expires_in'] || DEFAULT_TOKEN_LIFETIME_MS / 1000) * 1000;
            this.tokenExpiresAt = Date.now() + lifetimeMs;

            logger.debug('SpotifyManager', 'Spotify token refreshed', {
                expiresInMinutes: Math.round(lifetimeMs / 60000)
            });
        } catch (refreshError) {
            this.tokenExpiresAt = null;
            logger.error('SpotifyManager', 'Error refreshing token', {
                error: refreshError.message,
                stack: refreshError.stack
            });
            throw refreshError;
        }
    }

    async getOrCreateRequestsPlaylist() {
        if (this.requestsPlaylistId) return this.requestsPlaylistId;

        try {
            await this.ensureTokenValid();
            const playlists = await this.spotifyApi.getUserPlaylists();
            const requestsPlaylist = playlists.body.items.find(p => p.name === 'Chat Song Requests');

            if (requestsPlaylist) {
                this.requestsPlaylistId = requestsPlaylist.id;
            } else {
                const newPlaylist = await this.spotifyApi.createPlaylist('Chat Song Requests', {
                    description: 'Songs requested by Twitch chat'
                });
                this.requestsPlaylistId = newPlaylist.body.id;
            }

            return this.requestsPlaylistId;
        } catch (error) {
            logger.error('SpotifyManager', 'Error getting/creating requests playlist', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async addToRequestsPlaylist(trackUri) {
        try {
            await this.ensureTokenValid();
            const playlistId = await this.getOrCreateRequestsPlaylist();

            let offset = 0;
            const limit = 100;
            let trackExists = false;
            let hasMoreTracks = true;

            while (hasMoreTracks && !trackExists) {
                const response = await this.spotifyApi.getPlaylistTracks(playlistId, {
                    offset: offset,
                    limit: limit
                });

                trackExists = response.body.items.some(item => item.track?.uri === trackUri);

                hasMoreTracks = response.body.items.length === limit;
                offset += limit;
            }

            if (!trackExists) {
                await this.spotifyApi.addTracksToPlaylist(playlistId, [trackUri]);
                logger.debug('SpotifyManager', 'Added new track to requests playlist', { trackUri });
                return true;
            }

            return false;
        } catch (error) {
            logger.error('SpotifyManager', 'Error adding to requests playlist', {
                error: error.message,
                stack: error.stack,
                trackUri
            });
            throw error;
        }
    }
}

module.exports = SpotifyManager;
