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
    }

    startPlaybackMonitoring() {
        // Set initial state
        this.lastPlaybackState = 'NONE';
        
        setInterval(async () => {
            try {
                const currentState = await this.getPlaybackState();
                
                if (currentState !== this.lastPlaybackState) {
                    console.log(`* Spotify state changed: ${this.lastPlaybackState} -> ${currentState}`);
                }
                
                // Only process queue if state changes from CLOSED to active
                if ((currentState === 'PLAYING' || currentState === 'PAUSED') && 
                    this.lastPlaybackState === 'CLOSED') {
                    console.log('* Spotify became active, processing pending queue...');
                    await this.processPendingQueue();
                }
                
                this.lastPlaybackState = currentState;
            } catch (error) {
                console.error('Error monitoring playback:', error);
            }
        }, 5000);
    }
    
    startLastSongTracking() {
        setInterval(async () => {
            try {
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
                console.error('Error tracking last song:', error);
            }
        }, 5000);
    }
    
    async processPendingQueue() {
        const pendingTracks = this.queueManager.getPendingTracks();
        if (pendingTracks.length === 0) return;
    
        // Check Spotify state again just to be sure
        const state = await this.getPlaybackState();
        if (state === 'CLOSED') {
            console.log('* Spotify not active, will try processing queue later');
            return;
        }
    
        console.log('* Processing pending queue...');
        
        for (const track of pendingTracks) {
            try {
                await this.addToQueue(track.uri);
                console.log(`* Added pending track: ${track.name}`);
            } catch (error) {
                if (error.body?.error?.reason === 'NO_ACTIVE_DEVICE') {
                    console.log('* Spotify became inactive, will try again later');
                    return;
                }
                console.error(`Failed to add pending track ${track.name}:`, error);
                return;
            }
        }
    
        // Only clear the queue if all songs were added successfully
        this.queueManager.clearQueue();
        console.log('* Pending queue processed successfully');
    }

    async authenticate() {
        try {
            // If we have user tokens, try to use them
            if (this.tokenManager.tokens.spotifyUserAccessToken) {
                try {
                    // Test the token
                    await this.spotifyApi.getMe();
                    console.log('* Existing Spotify user auth valid');
                    return;
                } catch (error) {
                    // Token invalid, try refresh
                    try {
                        const data = await this.spotifyApi.refreshAccessToken();
                        this.spotifyApi.setAccessToken(data.body['access_token']);
                        this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
                        await this.tokenManager.saveTokens();
                        console.log('* Spotify token refreshed');
                        return;
                    } catch (refreshError) {
                        console.log('* Need new Spotify authorization');
                    }
                }
            }

            // Generate authorization URL
            const scopes = [
                'user-read-playback-state',
                'user-modify-playback-state',
                'user-read-currently-playing',
                'playlist-read-private',
                'playlist-read-collaborative',
                'playlist-modify-public',
                'playlist-modify-private'
            ];

            const authorizeURL = this.spotifyApi.createAuthorizeURL(scopes);
            console.log('\n* Please visit this URL to authorize your Spotify account:');
            console.log(authorizeURL);
            console.log('\n* After authorizing, copy the code from the URL and paste it here.');

            // Wait for user input
            const code = await this.waitForInput('Enter the code: ');

            // Get tokens
            const data = await this.spotifyApi.authorizationCodeGrant(code);

            // Save tokens
            this.spotifyApi.setAccessToken(data.body['access_token']);
            this.spotifyApi.setRefreshToken(data.body['refresh_token']);

            this.tokenManager.tokens.spotifyUserAccessToken = data.body['access_token'];
            this.tokenManager.tokens.spotifyUserRefreshToken = data.body['refresh_token'];
            await this.tokenManager.saveTokens();

            console.log('* Spotify user authentication successful');

        } catch (error) {
            console.error('Spotify authentication error:', error);
        }
    }

    // Helper function to get user input
    waitForInput(prompt) {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise((resolve) => {
            readline.question(prompt, (answer) => {
                readline.close();
                resolve(answer);
            });
        });
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
            console.error('Error getting playback state:', error);
            return 'CLOSED';
        }
    }

    async addToQueue(trackUri) {
        try {
            await this.ensureTokenValid();
            const state = await this.getPlaybackState();
    
            if (state === 'CLOSED') {
                console.log('* Spotify not active, will use pending queue');
                throw { body: { error: { reason: 'NO_ACTIVE_DEVICE' } } };
            }
    
            await this.spotifyApi.addToQueue(trackUri);
            return true;
        } catch (error) {
            if (error.body?.error?.reason !== 'NO_ACTIVE_DEVICE') {
                console.error('Error adding to queue:', error);
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
                    console.log('* Spotify token refreshed');
                } catch (refreshError) {
                    console.error('Error refreshing token:', refreshError);
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
            console.error('Error getting/creating requests playlist:', error);
            throw error;
        }
    }

    async addToRequestsPlaylist(trackUri) {
        try {
            await this.ensureTokenValid();
            const playlistId = await this.getOrCreateRequestsPlaylist();

            // Check if song already exists in playlist
            const tracks = await this.spotifyApi.getPlaylistTracks(playlistId);
            const trackExists = tracks.body.items.some(item => item.track.uri === trackUri);

            if (!trackExists) {
                await this.spotifyApi.addTracksToPlaylist(playlistId, [trackUri]);
                return true;
            }

            return false;
        } catch (error) {
            console.error('Error adding to requests playlist:', error);
            throw error;
        }
    }
}

module.exports = SpotifyManager;