// src/redemptions/songs/spotifyManager.js
const config = require('../../config/config');
const QueueManager = require('./queueManager');
const SpotifyWebApi = require('spotify-web-api-node');

class SpotifyManager {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
        this.spotifyApi = new SpotifyWebApi({
            clientId: this.tokenManager.tokens.spotifyClientId,
            clientSecret: this.tokenManager.tokens.spotifyClientSecret,
            redirectUri: 'http://127.0.0.1:3000/callback'
        });

        // Set tokens if we have them
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
        // Set initial state
        this.lastPlaybackState = 'NONE';
        
        setInterval(async () => {
            try {
                const currentState = await this.getPlaybackState();
                this.lastPlaybackState = currentState;
            } catch (error) {
                console.error('❌ Error monitoring playback:', error);
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
                    
                    // If less than 5 seconds remaining
                    if (remaining <  config.spotifyInterval) {
                        // Get next song from pending queue
                        const pendingTracks = await this.queueManager.getPendingTracks();
                        if (pendingTracks.length > 0) {
                            const nextTrack = pendingTracks[0];
                            
                            // Add to Spotify queue
                            await this.spotifyApi.addToQueue(nextTrack.uri);
                            console.log(`* Added next track to queue: ${nextTrack.name} by ${nextTrack.artist}`);
                            
                            // Remove from pending queue
                            await this.queueManager.removeFirstTrack();
                            console.log('* Removed track from pending queue');
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Error monitoring current track:', error);
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
                    // If current track is different from what we last stored
                    if (!this.lastPlayedTrack || 
                        this.lastPlayedTrack.id !== currentTrack.body.item.id) {
                        // Store the previous track before updating
                        if (this.lastPlayedTrack) {
                            this.previousTrack = {
                                name: this.lastPlayedTrack.name,
                                artist: this.lastPlayedTrack.artists[0].name
                            };
                        }
                        // Update current track
                        this.lastPlayedTrack = currentTrack.body.item;
                    }
                }
            } catch (error) {
                console.error('❌ Error tracking last song:', error);
            }
        }, config.spotifyInterval);
    }

    async authenticate() {
        try {
            // If we have user tokens, try to use them
            if (this.tokenManager.tokens.spotifyUserAccessToken) {
                try {
                    // Test the token
                    await this.spotifyApi.getMe();
                    console.log('✅ Existing Spotify user auth valid');
                    return;
                } catch (error) {
                    // Token invalid, try refresh
                    try {
                        const data = await this.spotifyApi.refreshAccessToken();
                        this.spotifyApi.setAccessToken(data.body['access_token']);
                        this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                        await this.tokenManager.saveTokens();
                        return;
                    } catch (refreshError) {
                        console.log('* Need new Spotify authorization');
                    }
                }
            }
        } catch (error) {
            console.error('Spotify authentication error:', error);
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
                console.error('❌ Error adding to queue:', error);
            }
            throw error;
        }
    }

    async ensureTokenValid() {
        try {
            // Try to get user info to test token
            await this.spotifyApi.getMe();
        } catch (error) {
            if (error.statusCode === 401) {  // Token expired
                try {
                    const data = await this.spotifyApi.refreshAccessToken();
                    this.spotifyApi.setAccessToken(data.body['access_token']);
                    this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                    await this.tokenManager.saveTokens();
                } catch (refreshError) {
                    console.error('❌ Error refreshing token:', refreshError);
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
            // Get user's playlists
            const playlists = await this.spotifyApi.getUserPlaylists();
            const requestsPlaylist = playlists.body.items.find(p => p.name === 'Chat Song Requests');

            if (requestsPlaylist) {
                this.requestsPlaylistId = requestsPlaylist.id;
            } else {
                // Create the playlist if it doesn't exist
                const newPlaylist = await this.spotifyApi.createPlaylist('Chat Song Requests', {
                    description: 'Songs requested by Twitch chat'
                });
                this.requestsPlaylistId = newPlaylist.body.id;
            }

            return this.requestsPlaylistId;
        } catch (error) {
            console.error('❌ Error getting/creating requests playlist:', error);
            throw error;
        }
    }

    async addToRequestsPlaylist(trackUri) {
        try {
            await this.ensureTokenValid();
            const playlistId = await this.getOrCreateRequestsPlaylist();
    
            // Initialize variables for pagination
            let offset = 0;
            const limit = 100; // Spotify's max limit per request
            let trackExists = false;
            let hasMoreTracks = true;
    
            // Check all pages of the playlist
            while (hasMoreTracks && !trackExists) {
                const response = await this.spotifyApi.getPlaylistTracks(playlistId, {
                    offset: offset,
                    limit: limit
                });
    
                // Check if track exists in current page
                trackExists = response.body.items.some(item => item.track?.uri === trackUri);
    
                // Update pagination variables
                hasMoreTracks = response.body.items.length === limit;
                offset += limit;
            }
    
            if (!trackExists) {
                await this.spotifyApi.addTracksToPlaylist(playlistId, [trackUri]);
                return true;
            }
    
            return false;
        } catch (error) {
            console.error('❌ Error adding to requests playlist:', error);
            throw error;
        }
    }
}

module.exports = SpotifyManager;