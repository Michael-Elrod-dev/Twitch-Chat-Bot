// tests/redemptions/songs/songRequest.test.js

const handleSongRequest = require('../../../src/redemptions/songs/songRequest');

describe('handleSongRequest', () => {
    let mockTwitchBot;
    let mockSpotifyManager;
    let event;

    beforeEach(() => {
        jest.clearAllMocks();

        mockSpotifyManager = {
            spotifyApi: {
                getTrack: jest.fn().mockResolvedValue({
                    body: {
                        name: 'Test Song',
                        artists: [{ name: 'Test Artist' }]
                    }
                })
            },
            queueManager: {
                addToPendingQueue: jest.fn().mockResolvedValue(true),
                addToPriorityQueue: jest.fn().mockResolvedValue(true)
            },
            addToRequestsPlaylist: jest.fn().mockResolvedValue(true)
        };

        mockTwitchBot = {
            redemptionManager: {
                updateRedemptionStatus: jest.fn().mockResolvedValue(true)
            },
            sendMessage: jest.fn().mockResolvedValue(true)
        };

        event = {
            input: 'https://open.spotify.com/track/1234567890?si=abcdef',
            userId: 'user-123',
            userDisplayName: 'testuser',
            broadcasterId: 'broadcaster-456',
            broadcasterDisplayName: 'streamer',
            rewardId: 'reward-789',
            rewardTitle: 'Song Request',
            id: 'redemption-abc'
        };
    });

    describe('Valid song requests', () => {
        it('should add regular song to pending queue', async () => {
            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockSpotifyManager.spotifyApi.getTrack).toHaveBeenCalledWith('1234567890');
            expect(mockSpotifyManager.queueManager.addToPendingQueue).toHaveBeenCalledWith({
                uri: 'spotify:track:1234567890',
                name: 'Test Song',
                artist: 'Test Artist',
                requestedBy: 'testuser'
            });

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'FULFILLED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                expect.stringContaining('Successfully added "Test Song" by Test Artist')
            );
        });

        it('should add priority song to priority queue', async () => {
            event.rewardTitle = 'Skip Song Queue';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockSpotifyManager.queueManager.addToPriorityQueue).toHaveBeenCalledWith({
                uri: 'spotify:track:1234567890',
                name: 'Test Song',
                artist: 'Test Artist',
                requestedBy: 'testuser'
            });

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                expect.stringContaining('priority queue')
            );
        });

        it('should handle song added to playlist', async () => {
            mockSpotifyManager.addToRequestsPlaylist.mockResolvedValue(true);

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                expect.stringContaining('This song is new and has been added to the Chat Playlist')
            );
        });

        it('should handle song already in playlist', async () => {
            mockSpotifyManager.addToRequestsPlaylist.mockResolvedValue(false);

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                expect.not.stringContaining('This song is new')
            );
        });

        it('should handle Spotify links with query parameters', async () => {
            event.input = 'https://open.spotify.com/track/abc123?si=xyz&other=param';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockSpotifyManager.spotifyApi.getTrack).toHaveBeenCalledWith('abc123');
        });

        it('should handle Spotify links without query parameters', async () => {
            event.input = 'https://open.spotify.com/track/abc123';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockSpotifyManager.spotifyApi.getTrack).toHaveBeenCalledWith('abc123');
        });
    });

    describe('Empty input validation', () => {
        it('should cancel redemption when input is empty', async () => {
            event.input = '';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Please provide a Spotify song link! Your points have been refunded.'
            );

            expect(mockSpotifyManager.spotifyApi.getTrack).not.toHaveBeenCalled();
        });

        it('should cancel redemption when input is whitespace', async () => {
            event.input = '   ';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });
    });

    describe('Invalid link validation', () => {
        it('should cancel redemption for non-Spotify link', async () => {
            event.input = 'https://youtube.com/watch?v=123';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Please provide a valid Spotify song link! Your points have been refunded.'
            );

            expect(mockSpotifyManager.spotifyApi.getTrack).not.toHaveBeenCalled();
        });

        it('should cancel redemption for invalid text', async () => {
            event.input = 'Just some random text';

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });
    });

    describe('Spotify API error handling', () => {
        it('should refund points when track not found', async () => {
            const trackError = new Error('Track not found');
            trackError.stack = 'Error stack';
            mockSpotifyManager.spotifyApi.getTrack.mockRejectedValue(trackError);

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Sorry, I couldn\'t process your request. Your points have been refunded.'
            );
        });

        it('should handle queue manager error', async () => {
            const queueError = new Error('Queue full');
            queueError.stack = 'Error stack';
            mockSpotifyManager.queueManager.addToPendingQueue.mockRejectedValue(queueError);

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });

        it('should continue if playlist add fails', async () => {
            const playlistError = new Error('Playlist error');
            playlistError.stack = 'Error stack';
            mockSpotifyManager.addToRequestsPlaylist.mockRejectedValue(playlistError);

            await handleSongRequest(event, mockTwitchBot, mockSpotifyManager);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'FULFILLED'
            );
        });
    });

    describe('Fatal error handling', () => {
        it('should not throw on any error', async () => {
            mockSpotifyManager.spotifyApi.getTrack.mockRejectedValue(new Error('Unexpected error'));

            await expect(
                handleSongRequest(event, mockTwitchBot, mockSpotifyManager)
            ).resolves.not.toThrow();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple requests in sequence', async () => {
            const events = [
                { ...event, input: 'https://open.spotify.com/track/111' },
                { ...event, input: 'https://open.spotify.com/track/222' },
                { ...event, input: 'https://open.spotify.com/track/333' }
            ];

            for (const evt of events) {
                await handleSongRequest(evt, mockTwitchBot, mockSpotifyManager);
            }

            expect(mockSpotifyManager.queueManager.addToPendingQueue).toHaveBeenCalledTimes(3);
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledTimes(3);
        });

        it('should handle mix of valid and invalid requests', async () => {
            const events = [
                { ...event, input: 'https://open.spotify.com/track/111' },
                { ...event, input: 'not a link' },
                { ...event, input: 'https://open.spotify.com/track/333' }
            ];

            for (const evt of events) {
                await handleSongRequest(evt, mockTwitchBot, mockSpotifyManager);
            }

            expect(mockSpotifyManager.queueManager.addToPendingQueue).toHaveBeenCalledTimes(2);
            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledTimes(3);
        });
    });
});
