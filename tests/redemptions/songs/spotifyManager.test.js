const SpotifyManager = require('../../../src/redemptions/songs/spotifyManager');

jest.mock('spotify-web-api-node');
jest.mock('../../../src/redemptions/songs/queueManager');
jest.mock('../../../src/config/config', () => ({
    spotifyInterval: 5000
}));

const SpotifyWebApi = require('spotify-web-api-node');
const QueueManager = require('../../../src/redemptions/songs/queueManager');

describe('SpotifyManager', () => {
    let spotifyManager;
    let mockTokenManager;
    let mockSpotifyApi;
    let mockQueueManager;
    let mockDbManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockTokenManager = {
            tokens: {
                spotifyClientId: 'test-client-id',
                spotifyClientSecret: 'test-client-secret',
                spotifyUserAccessToken: 'test-access-token',
                spotifyUserRefreshToken: 'test-refresh-token'
            },
            saveTokens: jest.fn().mockResolvedValue(true)
        };

        mockSpotifyApi = {
            setAccessToken: jest.fn(),
            setRefreshToken: jest.fn(),
            getMe: jest.fn().mockResolvedValue({ body: { id: 'user123' } }),
            refreshAccessToken: jest.fn().mockResolvedValue({
                body: { access_token: 'new-access-token' }
            }),
            getMyCurrentPlaybackState: jest.fn().mockResolvedValue({
                body: {
                    device: { id: 'device123' },
                    is_playing: true,
                    item: {
                        id: 'track123',
                        name: 'Test Track',
                        artists: [{ name: 'Test Artist' }],
                        duration_ms: 180000,
                        uri: 'spotify:track:track123'
                    },
                    progress_ms: 60000
                }
            }),
            getMyCurrentPlayingTrack: jest.fn().mockResolvedValue({
                body: {
                    item: {
                        id: 'track123',
                        name: 'Test Track',
                        artists: [{ name: 'Test Artist' }]
                    }
                }
            }),
            addToQueue: jest.fn().mockResolvedValue(true),
            getUserPlaylists: jest.fn().mockResolvedValue({
                body: {
                    items: []
                }
            }),
            createPlaylist: jest.fn().mockResolvedValue({
                body: { id: 'playlist123' }
            }),
            getPlaylistTracks: jest.fn().mockResolvedValue({
                body: { items: [] }
            }),
            addTracksToPlaylist: jest.fn().mockResolvedValue(true)
        };

        SpotifyWebApi.mockImplementation(() => mockSpotifyApi);

        mockQueueManager = {
            init: jest.fn().mockResolvedValue(true),
            getPendingTracks: jest.fn().mockResolvedValue([]),
            removeFirstTrack: jest.fn().mockResolvedValue(true)
        };

        QueueManager.mockImplementation(() => mockQueueManager);

        mockDbManager = {
            query: jest.fn().mockResolvedValue([])
        };

        spotifyManager = new SpotifyManager(mockTokenManager);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with token manager and Spotify API', () => {
            expect(spotifyManager.tokenManager).toBe(mockTokenManager);
            expect(SpotifyWebApi).toHaveBeenCalledWith({
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret',
                redirectUri: 'http://127.0.0.1:3000/callback'
            });
            expect(mockSpotifyApi.setAccessToken).toHaveBeenCalledWith('test-access-token');
            expect(mockSpotifyApi.setRefreshToken).toHaveBeenCalledWith('test-refresh-token');
        });

        it('should initialize without user tokens', () => {
            mockTokenManager.tokens.spotifyUserAccessToken = null;
            const manager = new SpotifyManager(mockTokenManager);

            expect(manager.requestsPlaylistId).toBeNull();
            expect(manager.lastPlaybackState).toBe('NONE');
        });

        it('should create queue manager instance', () => {
            expect(QueueManager).toHaveBeenCalled();
            expect(spotifyManager.queueManager).toBe(mockQueueManager);
        });
    });

    describe('init', () => {
        it('should initialize queue manager with database', async () => {
            await spotifyManager.init(mockDbManager);

            expect(mockQueueManager.init).toHaveBeenCalledWith(mockDbManager);
        });
    });

    describe('authenticate', () => {
        it('should validate existing token successfully', async () => {
            await spotifyManager.authenticate();

            expect(mockSpotifyApi.getMe).toHaveBeenCalled();
        });

        it('should refresh expired token', async () => {
            mockSpotifyApi.getMe
                .mockRejectedValueOnce(new Error('Token expired'))
                .mockResolvedValueOnce({ body: { id: 'user123' } });

            await spotifyManager.authenticate();

            expect(mockSpotifyApi.refreshAccessToken).toHaveBeenCalled();
            expect(mockSpotifyApi.setAccessToken).toHaveBeenCalledWith('new-access-token');
            expect(mockTokenManager.saveTokens).toHaveBeenCalled();
        });

        it('should handle refresh failure gracefully', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(new Error('Token invalid'));
            mockSpotifyApi.refreshAccessToken.mockRejectedValue(new Error('Refresh failed'));

            await spotifyManager.authenticate();

            expect(mockSpotifyApi.refreshAccessToken).toHaveBeenCalled();
        });

        it('should handle authentication without user tokens', async () => {
            mockTokenManager.tokens.spotifyUserAccessToken = null;
            const manager = new SpotifyManager(mockTokenManager);

            await manager.authenticate();

            expect(mockSpotifyApi.getMe).not.toHaveBeenCalled();
        });
    });

    describe('ensureTokenValid', () => {
        it('should pass when token is valid', async () => {
            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.getMe).toHaveBeenCalled();
        });

        it('should refresh token when expired (401)', async () => {
            const expiredError = new Error('Token expired');
            expiredError.statusCode = 401;
            mockSpotifyApi.getMe.mockRejectedValueOnce(expiredError);

            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.refreshAccessToken).toHaveBeenCalled();
            expect(mockTokenManager.tokens.spotifyUserAccessToken).toBe('new-access-token');
            expect(mockTokenManager.saveTokens).toHaveBeenCalled();
        });

        it('should throw when refresh fails', async () => {
            const expiredError = new Error('Token expired');
            expiredError.statusCode = 401;
            expiredError.stack = 'Error stack';
            const refreshError = new Error('Refresh failed');
            refreshError.stack = 'Refresh stack';

            mockSpotifyApi.getMe.mockRejectedValue(expiredError);
            mockSpotifyApi.refreshAccessToken.mockRejectedValue(refreshError);

            await expect(spotifyManager.ensureTokenValid()).rejects.toThrow('Refresh failed');
        });

        it('should throw for non-401 errors', async () => {
            const apiError = new Error('API error');
            apiError.statusCode = 500;
            mockSpotifyApi.getMe.mockRejectedValue(apiError);

            await expect(spotifyManager.ensureTokenValid()).rejects.toThrow('API error');
        });
    });

    describe('getPlaybackState', () => {
        it('should return PLAYING when music is playing', async () => {
            const state = await spotifyManager.getPlaybackState();

            expect(state).toBe('PLAYING');
            expect(mockSpotifyApi.getMyCurrentPlaybackState).toHaveBeenCalled();
        });

        it('should return PAUSED when music is paused', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue({
                body: {
                    device: { id: 'device123' },
                    is_playing: false
                }
            });

            const state = await spotifyManager.getPlaybackState();

            expect(state).toBe('PAUSED');
        });

        it('should return CLOSED when no device active', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue({
                body: null
            });

            const state = await spotifyManager.getPlaybackState();

            expect(state).toBe('CLOSED');
        });

        it('should return CLOSED when no body in response', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue({
                body: { device: null }
            });

            const state = await spotifyManager.getPlaybackState();

            expect(state).toBe('CLOSED');
        });

        it('should return CLOSED on error', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockRejectedValue(new Error('API error'));

            const state = await spotifyManager.getPlaybackState();

            expect(state).toBe('CLOSED');
        });
    });

    describe('addToQueue', () => {
        it('should add track to Spotify queue successfully', async () => {
            const result = await spotifyManager.addToQueue('spotify:track:abc123');

            expect(mockSpotifyApi.addToQueue).toHaveBeenCalledWith('spotify:track:abc123');
            expect(result).toBe(true);
        });

        it('should throw for NO_ACTIVE_DEVICE', async () => {
            const deviceError = new Error('No active device');
            deviceError.body = { error: { reason: 'NO_ACTIVE_DEVICE' } };
            mockSpotifyApi.addToQueue.mockRejectedValue(deviceError);

            await expect(spotifyManager.addToQueue('spotify:track:abc123')).rejects.toThrow();
        });

        it('should throw for other failures', async () => {
            const apiError = new Error('Queue error');
            apiError.stack = 'Error stack';
            apiError.body = { error: { reason: 'OTHER_ERROR' } };
            mockSpotifyApi.addToQueue.mockRejectedValue(apiError);

            await expect(spotifyManager.addToQueue('spotify:track:abc123')).rejects.toThrow('Queue error');
        });
    });

    describe('getOrCreateRequestsPlaylist', () => {
        it('should return cached playlist ID', async () => {
            spotifyManager.requestsPlaylistId = 'cached-playlist-123';

            const result = await spotifyManager.getOrCreateRequestsPlaylist();

            expect(result).toBe('cached-playlist-123');
            expect(mockSpotifyApi.getUserPlaylists).not.toHaveBeenCalled();
        });

        it('should find existing playlist', async () => {
            mockSpotifyApi.getUserPlaylists.mockResolvedValue({
                body: {
                    items: [
                        { id: 'playlist1', name: 'Other Playlist' },
                        { id: 'playlist2', name: 'Chat Song Requests' },
                        { id: 'playlist3', name: 'Another Playlist' }
                    ]
                }
            });

            const result = await spotifyManager.getOrCreateRequestsPlaylist();

            expect(result).toBe('playlist2');
            expect(spotifyManager.requestsPlaylistId).toBe('playlist2');
            expect(mockSpotifyApi.createPlaylist).not.toHaveBeenCalled();
        });

        it('should create playlist when not found', async () => {
            mockSpotifyApi.getUserPlaylists.mockResolvedValue({
                body: {
                    items: [
                        { id: 'playlist1', name: 'Other Playlist' }
                    ]
                }
            });

            const result = await spotifyManager.getOrCreateRequestsPlaylist();

            expect(mockSpotifyApi.createPlaylist).toHaveBeenCalledWith('Chat Song Requests', {
                description: 'Songs requested by Twitch chat'
            });
            expect(result).toBe('playlist123');
            expect(spotifyManager.requestsPlaylistId).toBe('playlist123');
        });

        it('should handle API error', async () => {
            const apiError = new Error('Spotify API error');
            apiError.stack = 'Error stack';
            mockSpotifyApi.getUserPlaylists.mockRejectedValue(apiError);

            await expect(spotifyManager.getOrCreateRequestsPlaylist()).rejects.toThrow('Spotify API error');
        });
    });

    describe('addToRequestsPlaylist', () => {
        beforeEach(() => {
            spotifyManager.requestsPlaylistId = 'playlist123';
        });

        it('should add new track to playlist', async () => {
            mockSpotifyApi.getPlaylistTracks.mockResolvedValue({
                body: {
                    items: [
                        { track: { uri: 'spotify:track:other1' } },
                        { track: { uri: 'spotify:track:other2' } }
                    ]
                }
            });

            const result = await spotifyManager.addToRequestsPlaylist('spotify:track:new123');

            expect(mockSpotifyApi.addTracksToPlaylist).toHaveBeenCalledWith('playlist123', ['spotify:track:new123']);
            expect(result).toBe(true);
        });

        it('should not add duplicate track', async () => {
            mockSpotifyApi.getPlaylistTracks.mockResolvedValue({
                body: {
                    items: [
                        { track: { uri: 'spotify:track:existing' } },
                        { track: { uri: 'spotify:track:duplicate123' } }
                    ]
                }
            });

            const result = await spotifyManager.addToRequestsPlaylist('spotify:track:duplicate123');

            expect(mockSpotifyApi.addTracksToPlaylist).not.toHaveBeenCalled();
            expect(result).toBe(false);
        });

        it('should handle pagination for large playlists', async () => {
            const firstPage = {
                body: {
                    items: Array(100).fill(null).map((_, i) => ({
                        track: { uri: `spotify:track:track${i}` }
                    }))
                }
            };

            const secondPage = {
                body: {
                    items: Array(50).fill(null).map((_, i) => ({
                        track: { uri: `spotify:track:track${i + 100}` }
                    }))
                }
            };

            mockSpotifyApi.getPlaylistTracks
                .mockResolvedValueOnce(firstPage)
                .mockResolvedValueOnce(secondPage);

            const result = await spotifyManager.addToRequestsPlaylist('spotify:track:new456');

            expect(mockSpotifyApi.getPlaylistTracks).toHaveBeenCalledTimes(2);
            expect(mockSpotifyApi.getPlaylistTracks).toHaveBeenNthCalledWith(1, 'playlist123', {
                offset: 0,
                limit: 100
            });
            expect(mockSpotifyApi.getPlaylistTracks).toHaveBeenNthCalledWith(2, 'playlist123', {
                offset: 100,
                limit: 100
            });
            expect(result).toBe(true);
        });

        it('should handle null track in playlist items', async () => {
            mockSpotifyApi.getPlaylistTracks.mockResolvedValue({
                body: {
                    items: [
                        { track: null },
                        { track: { uri: 'spotify:track:valid' } }
                    ]
                }
            });

            const result = await spotifyManager.addToRequestsPlaylist('spotify:track:new789');

            expect(result).toBe(true);
        });

        it('should handle API error', async () => {
            const apiError = new Error('Playlist error');
            apiError.stack = 'Error stack';
            mockSpotifyApi.getPlaylistTracks.mockRejectedValue(apiError);

            await expect(
                spotifyManager.addToRequestsPlaylist('spotify:track:error')
            ).rejects.toThrow('Playlist error');
        });
    });

    describe('Interval monitoring', () => {
        it('should NOT start monitors in the constructor', () => {
            expect(spotifyManager.lastPlaybackState).toBe('NONE');
            expect(spotifyManager.lastPlayedTrack).toBeNull();
            expect(spotifyManager.isMonitoring()).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should handle playback state tracking', async () => {
            const state = await spotifyManager.getPlaybackState();
            expect(state).toBe('PLAYING');
        });
    });

    describe('start / stop lifecycle', () => {
        afterEach(() => {
            spotifyManager.stop();
        });

        it('should start three polling loops', () => {
            spotifyManager.start();

            expect(spotifyManager.isMonitoring()).toBe(true);
            expect(jest.getTimerCount()).toBe(3);
        });

        it('should not stack monitors when started twice', () => {
            spotifyManager.start();
            spotifyManager.start();

            expect(jest.getTimerCount()).toBe(3);
        });

        it('should clear every loop on stop', () => {
            spotifyManager.start();
            spotifyManager.stop();

            expect(spotifyManager.isMonitoring()).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should be safe to stop twice', () => {
            spotifyManager.start();
            spotifyManager.stop();

            expect(() => spotifyManager.stop()).not.toThrow();
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should be safe to stop when never started', () => {
            expect(() => spotifyManager.stop()).not.toThrow();
        });

        it('should restart cleanly after a stop', () => {
            spotifyManager.start();
            spotifyManager.stop();
            spotifyManager.start();

            expect(jest.getTimerCount()).toBe(3);
        });

        it('should leave no monitors running across many cycles', () => {
            for (let i = 0; i < 5; i++) {
                spotifyManager.start();
                spotifyManager.stop();
            }

            expect(jest.getTimerCount()).toBe(0);
        });

        it('should poll once per interval tick while running', async () => {
            spotifyManager.start();

            // Async advance so the awaits inside the poll bodies actually settle.
            await jest.advanceTimersByTimeAsync(5000);

            expect(mockSpotifyApi.getMyCurrentPlaybackState).toHaveBeenCalled();
        });

        it('should stop polling after stop', async () => {
            spotifyManager.start();
            spotifyManager.stop();
            jest.clearAllMocks();

            await jest.advanceTimersByTimeAsync(60000);

            expect(mockSpotifyApi.getMyCurrentPlaybackState).not.toHaveBeenCalled();
        });
    });

    describe('advanceQueueIfTrackEnding', () => {
        const endingTrack = (isPlaying) => ({
            body: {
                device: { id: 'device123' },
                is_playing: isPlaying,
                item: { id: 'track123', duration_ms: 180000 },
                progress_ms: 179000
            }
        });

        beforeEach(() => {
            mockQueueManager.getPendingTracks.mockResolvedValue([
                { uri: 'spotify:track:next', name: 'Next Song', artist: 'Artist', requestedBy: 'user' }
            ]);
        });

        it('should queue the next track when the current one is about to end', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue(endingTrack(true));

            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockSpotifyApi.addToQueue).toHaveBeenCalledWith('spotify:track:next');
            expect(mockQueueManager.removeFirstTrack).toHaveBeenCalled();
        });

        it('should NOT drain the queue while playback is paused', async () => {
            // Pausing near the end of a track used to make every tick shovel another
            // queued song into Spotify and delete its row.
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue(endingTrack(false));

            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockSpotifyApi.addToQueue).not.toHaveBeenCalled();
            expect(mockQueueManager.removeFirstTrack).not.toHaveBeenCalled();
        });

        it('should not drain the queue over repeated paused ticks', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue(endingTrack(false));

            await spotifyManager.advanceQueueIfTrackEnding();
            await spotifyManager.advanceQueueIfTrackEnding();
            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockQueueManager.removeFirstTrack).not.toHaveBeenCalled();
        });

        it('should not advance when plenty of the track remains', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue({
                body: {
                    is_playing: true,
                    item: { id: 'track123', duration_ms: 180000 },
                    progress_ms: 1000
                }
            });

            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockSpotifyApi.addToQueue).not.toHaveBeenCalled();
        });

        it('should do nothing when the queue is empty', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue(endingTrack(true));
            mockQueueManager.getPendingTracks.mockResolvedValue([]);

            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockSpotifyApi.addToQueue).not.toHaveBeenCalled();
        });

        it('should do nothing when nothing is loaded', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockResolvedValue({ body: {} });

            await spotifyManager.advanceQueueIfTrackEnding();

            expect(mockSpotifyApi.addToQueue).not.toHaveBeenCalled();
        });

        it('should swallow API errors', async () => {
            mockSpotifyApi.getMyCurrentPlaybackState.mockRejectedValue(new Error('Spotify down'));

            await expect(spotifyManager.advanceQueueIfTrackEnding()).resolves.toBeUndefined();
        });
    });
    describe('auth-dead gate', () => {
        afterEach(() => {
            spotifyManager.stop();
        });

        it('should report success when the existing token is valid', async () => {
            await expect(spotifyManager.authenticate()).resolves.toBe(true);
            expect(spotifyManager.authValid).toBe(true);
        });

        it('should report success when the token is refreshed', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(new Error('401'));

            await expect(spotifyManager.authenticate()).resolves.toBe(true);
            expect(spotifyManager.authValid).toBe(true);
        });

        it('should report failure when the refresh fails', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(new Error('401'));
            mockSpotifyApi.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

            await expect(spotifyManager.authenticate()).resolves.toBe(false);
            expect(spotifyManager.authValid).toBe(false);
        });

        it('should report failure when no user token is configured', async () => {
            mockTokenManager.tokens.spotifyUserAccessToken = null;
            const manager = new SpotifyManager(mockTokenManager);

            await expect(manager.authenticate()).resolves.toBe(false);
        });

        it('should refuse to start monitors when auth is dead', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(new Error('401'));
            mockSpotifyApi.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
            await spotifyManager.authenticate();

            spotifyManager.start();

            // Starting here would mean polling a dead API every few seconds forever.
            expect(spotifyManager.isMonitoring()).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should start monitors once auth is valid', async () => {
            await spotifyManager.authenticate();

            spotifyManager.start();

            expect(spotifyManager.isMonitoring()).toBe(true);
        });

        it('should start when authenticate has not been called yet', () => {
            // authValid stays null until checked; only an explicit false blocks start.
            spotifyManager.start();

            expect(spotifyManager.isMonitoring()).toBe(true);
        });
    });

    describe('token validity by timestamp', () => {
        it('should probe once when validity is unknown', async () => {
            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.getMe).toHaveBeenCalledTimes(1);
        });

        it('should not probe again while the token is known valid', async () => {
            await spotifyManager.ensureTokenValid();
            jest.clearAllMocks();

            // Three poll loops call this every few seconds; each used to cost a
            // Spotify API call just to ask "still valid?".
            await spotifyManager.ensureTokenValid();
            await spotifyManager.ensureTokenValid();
            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.getMe).not.toHaveBeenCalled();
        });

        it('should probe again once the token nears expiry', async () => {
            await spotifyManager.ensureTokenValid();
            spotifyManager.tokenExpiresAt = Date.now() + 1000;
            jest.clearAllMocks();

            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.getMe).toHaveBeenCalledTimes(1);
        });

        it('should still refresh on a 401, as before', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(Object.assign(new Error('401'), { statusCode: 401 }));

            await spotifyManager.ensureTokenValid();

            expect(mockSpotifyApi.refreshAccessToken).toHaveBeenCalled();
            expect(mockSpotifyApi.setAccessToken).toHaveBeenCalledWith('new-access-token');
        });

        it('should record expiry from the refresh response', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(Object.assign(new Error('401'), { statusCode: 401 }));
            mockSpotifyApi.refreshAccessToken.mockResolvedValue({
                body: { access_token: 'new-access-token', expires_in: 3600 }
            });

            await spotifyManager.ensureTokenValid();

            expect(spotifyManager.tokenExpiresAt).toBeGreaterThan(Date.now() + 3000000);
        });

        it('should rethrow a non-401 error, as before', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(Object.assign(new Error('500'), { statusCode: 500 }));

            await expect(spotifyManager.ensureTokenValid()).rejects.toThrow('500');
        });

        it('should clear known validity when a refresh fails', async () => {
            mockSpotifyApi.getMe.mockRejectedValue(Object.assign(new Error('401'), { statusCode: 401 }));
            mockSpotifyApi.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

            await expect(spotifyManager.ensureTokenValid()).rejects.toThrow('invalid_grant');
            expect(spotifyManager.tokenExpiresAt).toBeNull();
        });
    });
});
