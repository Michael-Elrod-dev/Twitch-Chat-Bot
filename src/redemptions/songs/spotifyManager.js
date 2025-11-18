// src/redemptions/songs/spotifyManager.js

const config = require('../../config/config');
const QueueManager = require('./queueManager');
const SpotifyWebApi = require('spotify-web-api-node');
const logger = require('../../logger/logger');

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
        this.startPlaybackMonitoring();
        this.lastPlayedTrack = null;
        this.startLastSongTracking();
        this.monitorCurrentTrack();
    }

    async init(dbManager) {
        await this.queueManager.init(dbManager);
    }

    startPlaybackMonitoring() {
        this.lastPlaybackState = 'NONE';

        setInterval(async () => {
            try {
                const currentState = await this.getPlaybackState();
                this.lastPlaybackState = currentState;
            } catch (error) {
                logger.error('SpotifyManager', 'Error monitoring playback', {
                    error: error.message,
                    stack: error.stack
                });
            }
        }, config.spotifyInterval);
    }

    async monitorCurrentTrack() {
        setInterval(async () => {
            try {
                await this.ensureTokenValid();
                const currentPlayback = await this.spotifyApi.getMyCurrentPlaybackState();

                if (currentPlayback.body && currentPlayback.body.item) {
                    const totalDuration = currentPlayback.body.item.duration_ms;
                    const progress = currentPlayback.body.progress_ms;
                    const remaining = totalDuration - progress;

                    if (remaining <  config.spotifyInterval) {
                        const pendingTracks = await this.queueManager.getPendingTracks();
                        if (pendingTracks.length > 0) {
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
                        }
                    }
                }
            } catch (error) {
                logger.error('SpotifyManager', 'Error monitoring current track', {
                    error: error.message,
                    stack: error.stack
                });
            }
        }, config.spotifyInterval);
    }

    startLastSongTracking() {
        setInterval(async () => {
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
        }, config.spotifyInterval);
    }

    async authenticate() {
        try {
            if (this.tokenManager.tokens.spotifyUserAccessToken) {
                try {
                    await this.spotifyApi.getMe();
                    logger.info('SpotifyManager', 'Existing Spotify user auth valid');
                    return;
                } catch (error) {
                    try {
                        const data = await this.spotifyApi.refreshAccessToken();
                        this.spotifyApi.setAccessToken(data.body['access_token']);
                        this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                        await this.tokenManager.saveTokens();
                        logger.info('SpotifyManager', 'Spotify token refreshed successfully');
                        return;
                    } catch (refreshError) {
                        logger.warn('SpotifyManager', 'Need new Spotify authorization');
                    }
                }
            }
        } catch (error) {
            logger.error('SpotifyManager', 'Spotify authentication error', {
                error: error.message,
                stack: error.stack
            });
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

    async ensureTokenValid() {
        try {
            await this.spotifyApi.getMe();
        } catch (error) {
            if (error.statusCode === 401) {
                try {
                    const data = await this.spotifyApi.refreshAccessToken();
                    this.spotifyApi.setAccessToken(data.body['access_token']);
                    this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                    await this.tokenManager.saveTokens();
                    logger.debug('SpotifyManager', 'Token refreshed in ensureTokenValid');
                } catch (refreshError) {
                    logger.error('SpotifyManager', 'Error refreshing token', {
                        error: refreshError.message,
                        stack: refreshError.stack
                    });
                    throw refreshError;
                }
            } else {
                throw error;
            }
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
