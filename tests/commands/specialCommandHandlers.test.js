// tests/commands/specialCommandHandlers.test.js

const specialCommandHandlers = require('../../src/commands/specialCommandHandlers');

// Mock node-fetch
jest.mock('node-fetch', () => {
    const actualFetch = jest.requireActual('node-fetch');
    return jest.fn((...args) => actualFetch.default(...args));
});

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../../src/logger/logger');

describe('SpecialCommandHandlers', () => {
    let handlers;
    let mockTwitchBot;
    let mockQuoteManager;
    let mockSpotifyManager;
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();

        mockQuoteManager = {
            dbManager: {},
            init: jest.fn().mockResolvedValue(true),
            getTotalQuotes: jest.fn().mockResolvedValue(5),
            getQuoteById: jest.fn(),
            getRandomQuote: jest.fn()
        };

        mockSpotifyManager = {
            ensureTokenValid: jest.fn().mockResolvedValue(true),
            spotifyApi: {
                getMyCurrentPlayingTrack: jest.fn(),
                addToQueue: jest.fn(),
                skipToNext: jest.fn()
            },
            previousTrack: null,
            queueManager: {
                getPendingTracks: jest.fn().mockResolvedValue([]),
                removeFirstTrack: jest.fn()
            },
            getPlaybackState: jest.fn().mockResolvedValue('PLAYING')
        };

        mockTwitchBot = {
            sendMessage: jest.fn().mockResolvedValue(true),
            streams: {
                getStreamByUserName: jest.fn()
            },
            users: {
                getUserByName: jest.fn()
            },
            channelPoints: {
                getCustomRewards: jest.fn(),
                updateCustomReward: jest.fn()
            },
            analyticsManager: {
                dbManager: {
                    query: jest.fn().mockResolvedValue([])
                }
            },
            viewerManager: {
                getUserMessages: jest.fn().mockResolvedValue(10),
                getUserCommands: jest.fn().mockResolvedValue(5),
                getUserRedemptions: jest.fn().mockResolvedValue(2),
                getTopUsers: jest.fn().mockResolvedValue(['user1: 100', 'user2: 90'])
            },
            emoteManager: {
                addEmote: jest.fn()
            }
        };

        mockContext = {
            username: 'testuser',
            userId: 'user-123',
            mod: false,
            badges: {}
        };

        handlers = specialCommandHandlers({
            quoteManager: mockQuoteManager,
            spotifyManager: mockSpotifyManager
        });
    });

    describe('Utility Functions', () => {
        // We can't directly test the helper functions since they're not exported,
        // but we can test their behavior through commands that use them

        describe('getUserSeed via fursona command', () => {
            it('should generate consistent fursona for same user', async () => {
                await handlers.fursona(mockTwitchBot, 'channel', mockContext, []);
                const firstCall = mockTwitchBot.sendMessage.mock.calls[0][1];

                await handlers.fursona(mockTwitchBot, 'channel', mockContext, []);
                const secondCall = mockTwitchBot.sendMessage.mock.calls[1][1];

                expect(firstCall).toBe(secondCall);
            });

            it('should generate different fursona for different users', async () => {
                await handlers.fursona(mockTwitchBot, 'channel', mockContext, []);
                const firstCall = mockTwitchBot.sendMessage.mock.calls[0][1];

                const differentContext = { ...mockContext, username: 'differentuser' };
                await handlers.fursona(mockTwitchBot, 'channel', differentContext, []);
                const secondCall = mockTwitchBot.sendMessage.mock.calls[1][1];

                expect(firstCall).not.toBe(secondCall);
            });
        });
    });

    describe('fursona command', () => {
        it('should generate fursona for requesting user', async () => {
            await handlers.fursona(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringMatching(/@testuser, here is your fursona https:\/\/thisfursonadoesnotexist\.com.*/)
            );
        });

        it('should generate fursona for mentioned user', async () => {
            await handlers.fursona(mockTwitchBot, 'channel', mockContext, ['@otheruser']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringMatching(/@otheruser, here is your fursona/)
            );
        });

        it('should handle user without @ symbol', async () => {
            await handlers.fursona(mockTwitchBot, 'channel', mockContext, ['otheruser']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringMatching(/@otheruser, here is your fursona/)
            );
        });
    });

    describe('waifu command', () => {
        it('should generate waifu for requesting user', async () => {
            await handlers.waifu(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringMatching(/@testuser, here is your waifu https:\/\/arfa\.dev\/waifu-ed.*/)
            );
        });

        it('should generate waifu for mentioned user', async () => {
            await handlers.waifu(mockTwitchBot, 'channel', mockContext, ['@otheruser']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringMatching(/@otheruser, here is your waifu/)
            );
        });
    });

    describe('quoteHandler command', () => {
        it('should return message when no quotes exist', async () => {
            mockQuoteManager.getTotalQuotes.mockResolvedValue(0);

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith('channel', 'No quotes saved yet!');
        });

        it('should get random quote when no ID provided', async () => {
            mockQuoteManager.getRandomQuote.mockResolvedValue({
                id: 3,
                quote: 'Random quote',
                author: 'Someone',
                savedAt: new Date('2024-01-15')
            });

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, []);

            expect(mockQuoteManager.getRandomQuote).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Quote #3/5 - \'Random quote\' - Someone, 2024'
            );
        });

        it('should get specific quote by ID', async () => {
            mockQuoteManager.getQuoteById.mockResolvedValue({
                id: 2,
                quote: 'Specific quote',
                author: 'Author',
                savedAt: new Date('2023-06-10')
            });

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, ['2']);

            expect(mockQuoteManager.getQuoteById).toHaveBeenCalledWith(2);
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Quote #2/5 - \'Specific quote\' - Author, 2023'
            );
        });

        it('should handle quote not found', async () => {
            mockQuoteManager.getQuoteById.mockResolvedValue(null);

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, ['999']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith('channel', 'Quote #999 not found!');
            expect(logger.debug).toHaveBeenCalled();
        });

        it('should initialize quoteManager if not initialized', async () => {
            mockQuoteManager.dbManager = null;

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, []);

            expect(mockQuoteManager.init).toHaveBeenCalledWith(mockTwitchBot.analyticsManager.dbManager);
        });

        it('should handle database error gracefully', async () => {
            mockQuoteManager.getTotalQuotes.mockRejectedValue(new Error('DB error'));

            await handlers.quoteHandler(mockTwitchBot, 'channel', mockContext, []);

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Sorry, there was an error retrieving quotes.'
            );
        });
    });

    describe('currentSong command', () => {
        it('should display currently playing song', async () => {
            mockSpotifyManager.spotifyApi.getMyCurrentPlayingTrack.mockResolvedValue({
                body: {
                    item: {
                        name: 'Test Song',
                        artists: [{ name: 'Test Artist' }]
                    }
                }
            });

            await handlers.currentSong(mockTwitchBot, 'channel');

            expect(mockSpotifyManager.ensureTokenValid).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Currently playing: Test Song by Test Artist'
            );
            expect(logger.info).toHaveBeenCalled();
        });

        it('should handle no song playing', async () => {
            mockSpotifyManager.spotifyApi.getMyCurrentPlayingTrack.mockResolvedValue({
                body: null
            });

            await handlers.currentSong(mockTwitchBot, 'channel');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'No song is currently playing in Spotify.'
            );
        });

        it('should handle Spotify API error', async () => {
            mockSpotifyManager.ensureTokenValid.mockRejectedValue(new Error('Token expired'));

            await handlers.currentSong(mockTwitchBot, 'channel');

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Unable to fetch current song information.'
            );
        });
    });

    describe('lastSong command', () => {
        it('should display last played song', async () => {
            mockSpotifyManager.previousTrack = {
                name: 'Previous Song',
                artist: 'Previous Artist'
            };

            await handlers.lastSong(mockTwitchBot, 'channel');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Last played song: Previous Song by Previous Artist'
            );
        });

        it('should handle no previous song', async () => {
            mockSpotifyManager.previousTrack = null;

            await handlers.lastSong(mockTwitchBot, 'channel');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'No previous song information available yet.'
            );
        });

        it('should handle error gracefully', async () => {
            // Force an error by making previousTrack throw
            Object.defineProperty(mockSpotifyManager, 'previousTrack', {
                get: () => { throw new Error('Access error'); }
            });

            await handlers.lastSong(mockTwitchBot, 'channel');

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Unable to fetch last song information.'
            );
        });
    });

    describe('combinedStats command', () => {
        it('should show stats for requesting user', async () => {
            await handlers.combinedStats(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.viewerManager.getUserMessages).toHaveBeenCalledWith('testuser');
            expect(mockTwitchBot.viewerManager.getUserCommands).toHaveBeenCalledWith('testuser');
            expect(mockTwitchBot.viewerManager.getUserRedemptions).toHaveBeenCalledWith('testuser');
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                '@testuser has 17 total interactions (10 messages, 5 commands, 2 redemptions)'
            );
        });

        it('should show stats for mentioned user', async () => {
            mockTwitchBot.viewerManager.getUserMessages.mockResolvedValue(20);
            mockTwitchBot.viewerManager.getUserCommands.mockResolvedValue(10);
            mockTwitchBot.viewerManager.getUserRedemptions.mockResolvedValue(5);

            await handlers.combinedStats(mockTwitchBot, 'channel', mockContext, ['@otheruser']);

            expect(mockTwitchBot.viewerManager.getUserMessages).toHaveBeenCalledWith('otheruser');
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                '@otheruser has 35 total interactions (20 messages, 10 commands, 5 redemptions)'
            );
        });

        it('should handle database error', async () => {
            mockTwitchBot.viewerManager.getUserMessages.mockRejectedValue(new Error('DB error'));

            await handlers.combinedStats(mockTwitchBot, 'channel', mockContext, []);

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'An error occurred while fetching chat stats.'
            );
        });
    });

    describe('topStats command', () => {
        it('should display top users', async () => {
            await handlers.topStats(mockTwitchBot, 'channel', mockContext);

            expect(mockTwitchBot.viewerManager.getTopUsers).toHaveBeenCalledWith(5);
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Top 5 Most Active Viewers: user1: 100 | user2: 90'
            );
        });

        it('should use viewerTracker directly if viewerManager unavailable', async () => {
            mockTwitchBot.viewerManager = null;
            mockTwitchBot.analyticsManager.viewerTracker = {
                getTopUsers: jest.fn().mockResolvedValue(['user1: 50', 'user2: 40'])
            };

            await handlers.topStats(mockTwitchBot, 'channel', mockContext);

            expect(mockTwitchBot.analyticsManager.viewerTracker.getTopUsers).toHaveBeenCalledWith(5);
        });

        it('should handle error gracefully', async () => {
            mockTwitchBot.viewerManager.getTopUsers.mockRejectedValue(new Error('DB error'));

            await handlers.topStats(mockTwitchBot, 'channel', mockContext);

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'An error occurred while fetching top stats.'
            );
        });
    });

    describe('nextSong command', () => {
        it('should show next song in queue', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([
                {
                    name: 'Next Song',
                    artist: 'Next Artist',
                    requestedBy: 'user1'
                }
            ]);

            await handlers.nextSong(mockTwitchBot, 'channel');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Next song in queue: Next Song by Next Artist (requested by user1)'
            );
        });

        it('should handle empty queue', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([]);

            await handlers.nextSong(mockTwitchBot, 'channel');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'There are no songs in the queue.'
            );
        });

        it('should handle error gracefully', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockRejectedValue(new Error('DB error'));

            await handlers.nextSong(mockTwitchBot, 'channel');

            expect(logger.error).toHaveBeenCalled();
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Unable to fetch next song information.'
            );
        });
    });

    describe('queueInfo command', () => {
        it('should show queue info for requesting user', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([
                { requestedBy: 'testuser' },
                { requestedBy: 'otheruser' },
                { requestedBy: 'testuser' }
            ]);

            await handlers.queueInfo(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Queue length: 3 songs | testuser\'s songs are in positions: 1, 3'
            );
        });

        it('should handle singular song count', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([
                { requestedBy: 'testuser' }
            ]);

            await handlers.queueInfo(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Queue length: 1 song | testuser\'s songs are in position: 1'
            );
        });

        it('should handle user with no songs in queue', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([
                { requestedBy: 'otheruser' }
            ]);

            await handlers.queueInfo(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Queue length: 1 song | testuser has no songs in queue'
            );
        });

        it('should handle empty queue', async () => {
            mockSpotifyManager.queueManager.getPendingTracks.mockResolvedValue([]);

            await handlers.queueInfo(mockTwitchBot, 'channel', mockContext, []);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'The queue is currently empty.'
            );
        });
    });

    describe('emoteAdd command', () => {
        beforeEach(() => {
            mockContext.mod = true;
        });

        it('should add emote successfully', async () => {
            mockTwitchBot.emoteManager.addEmote.mockResolvedValue(true);

            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['pog', 'PogChamp']);

            expect(mockTwitchBot.emoteManager.addEmote).toHaveBeenCalledWith('pog', 'PogChamp');
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Emote "pog" added successfully!'
            );
        });

        it('should handle duplicate emote', async () => {
            mockTwitchBot.emoteManager.addEmote.mockResolvedValue(false);

            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['pog', 'PogChamp']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Emote "pog" already exists.'
            );
        });

        it('should require mod permissions', async () => {
            mockContext.mod = false;
            mockContext.badges = {};

            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['pog', 'PogChamp']);

            expect(mockTwitchBot.emoteManager.addEmote).not.toHaveBeenCalled();
        });

        it('should allow broadcaster to add emotes', async () => {
            mockContext.mod = false;
            mockContext.badges = { broadcaster: '1' };
            mockTwitchBot.emoteManager.addEmote.mockResolvedValue(true);

            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['pog', 'PogChamp']);

            expect(mockTwitchBot.emoteManager.addEmote).toHaveBeenCalled();
        });

        it('should show usage when insufficient args', async () => {
            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['trigger']);

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Usage: !emoteadd <trigger> <response>'
            );
        });

        it('should handle multi-word responses', async () => {
            mockTwitchBot.emoteManager.addEmote.mockResolvedValue(true);

            await handlers.emoteAdd(mockTwitchBot, 'channel', mockContext, ['pog', 'This', 'is', 'poggers']);

            expect(mockTwitchBot.emoteManager.addEmote).toHaveBeenCalledWith('pog', 'This is poggers');
        });
    });

    describe('toggleAI command', () => {
        beforeEach(() => {
            mockContext.mod = true;
        });

        it('should enable AI when using !aion', async () => {
            mockTwitchBot.analyticsManager.dbManager.query
                .mockResolvedValueOnce([{ token_value: 'false' }])
                .mockResolvedValueOnce({});

            await handlers.toggleAI(mockTwitchBot, 'channel', mockContext, [], '!aion');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'AI responses have been turned on'
            );
        });

        it('should disable AI when using !aioff', async () => {
            mockTwitchBot.analyticsManager.dbManager.query
                .mockResolvedValueOnce([{ token_value: 'true' }])
                .mockResolvedValueOnce({});

            await handlers.toggleAI(mockTwitchBot, 'channel', mockContext, [], '!aioff');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'AI responses have been turned off'
            );
        });

        it('should not toggle if already in desired state', async () => {
            mockTwitchBot.analyticsManager.dbManager.query.mockResolvedValue([{ token_value: 'true' }]);

            await handlers.toggleAI(mockTwitchBot, 'channel', mockContext, [], '!aion');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'AI responses are already turned on'
            );
        });

        it('should require mod permissions', async () => {
            mockContext.mod = false;
            mockContext.badges = {};

            await handlers.toggleAI(mockTwitchBot, 'channel', mockContext, [], '!aion');

            expect(mockTwitchBot.analyticsManager.dbManager.query).not.toHaveBeenCalled();
        });
    });
});
