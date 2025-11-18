// tests/tokens/twitchAPI.test.js

const TwitchAPI = require('../../src/tokens/twitchAPI');

jest.mock('node-fetch');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    twitchApiEndpoint: 'https://api.twitch.tv/helix'
}));

const fetch = require('node-fetch');
const logger = require('../../src/logger/logger');

describe('TwitchAPI', () => {
    let twitchAPI;
    let mockTokenManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockTokenManager = {
            tokens: {
                broadcasterAccessToken: 'test-broadcaster-token',
                clientId: 'test-client-id',
                AccessToken: 'test-access-token',
                ClientID: 'test-client-id-caps'
            }
        };

        twitchAPI = new TwitchAPI(mockTokenManager);
    });

    describe('constructor', () => {
        it('should initialize with token manager', () => {
            expect(twitchAPI.tokenManager).toBe(mockTokenManager);
            expect(logger.debug).toHaveBeenCalledWith('TwitchAPI', 'TwitchAPI instance created');
        });
    });

    describe('getChannelId', () => {
        it('should fetch channel ID successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: '123456',
                        login: 'testuser',
                        display_name: 'TestUser'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChannelId('testuser');

            expect(result).toBe('123456');
            expect(fetch).toHaveBeenCalledWith(
                'https://api.twitch.tv/helix/users?login=testuser',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Client-Id': 'test-client-id-caps',
                        'Authorization': 'Bearer test-access-token'
                    })
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully retrieved channel ID',
                expect.objectContaining({
                    username: 'testuser',
                    channelId: '123456'
                })
            );
        });

        it('should throw error when user not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(twitchAPI.getChannelId('nonexistentuser')).rejects.toThrow('User not found');

            expect(logger.warn).toHaveBeenCalledWith(
                'TwitchAPI',
                'User not found',
                expect.objectContaining({ username: 'nonexistentuser' })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(twitchAPI.getChannelId('testuser')).rejects.toThrow('Network request failed');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to get channel ID',
                expect.objectContaining({
                    error: 'Network request failed',
                    username: 'testuser'
                })
            );
        });
    });

    describe('getStreamByUserName', () => {
        it('should fetch live stream information', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [{
                        started_at: '2024-01-15T10:00:00Z',
                        viewer_count: 150
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getStreamByUserName('teststreamer');

            expect(result).toEqual({
                startDate: '2024-01-15T10:00:00Z',
                viewer_count: 150
            });
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Stream is live',
                expect.objectContaining({
                    username: 'teststreamer',
                    viewerCount: 150
                })
            );
        });

        it('should return null when stream is offline', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getStreamByUserName('teststreamer');

            expect(result).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'TwitchAPI',
                'Stream not found or offline',
                expect.objectContaining({ username: 'teststreamer' })
            );
        });

        it('should handle API error', async () => {
            const apiError = new Error('API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getStreamByUserName('teststreamer')).rejects.toThrow('API error');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to get stream information',
                expect.objectContaining({
                    error: 'API error',
                    username: 'teststreamer'
                })
            );
        });
    });

    describe('getUserByName', () => {
        it('should fetch user information successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: '987654',
                        login: 'testuser',
                        display_name: 'TestUser',
                        profile_image_url: 'https://example.com/image.png'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getUserByName('testuser');

            expect(result).toEqual({
                id: '987654',
                login: 'testuser',
                display_name: 'TestUser',
                profile_image_url: 'https://example.com/image.png'
            });
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully retrieved user information',
                expect.objectContaining({
                    username: 'testuser',
                    userId: '987654',
                    displayName: 'TestUser'
                })
            );
        });

        it('should return null when user not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getUserByName('nonexistentuser');

            expect(result).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'TwitchAPI',
                'User not found',
                expect.objectContaining({ username: 'nonexistentuser' })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network error');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(twitchAPI.getUserByName('testuser')).rejects.toThrow('Network error');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to get user information',
                expect.objectContaining({
                    error: 'Network error',
                    username: 'testuser'
                })
            );
        });
    });

    describe('getCustomRewards', () => {
        it('should fetch custom rewards successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [
                        {
                            id: 'reward-1',
                            title: 'Song Request',
                            cost: 500
                        },
                        {
                            id: 'reward-2',
                            title: 'Hydrate',
                            cost: 100
                        }
                    ]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getCustomRewards('broadcaster-123');

            expect(result).toEqual([
                { id: 'reward-1', title: 'Song Request', cost: 500 },
                { id: 'reward-2', title: 'Hydrate', cost: 100 }
            ]);
            expect(logger.debug).toHaveBeenCalledWith(
                'TwitchAPI',
                'Fetching custom rewards',
                expect.objectContaining({ broadcasterId: 'broadcaster-123' })
            );
        });

        it('should handle API error', async () => {
            const apiError = new Error('Unauthorized');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getCustomRewards('broadcaster-123')).rejects.toThrow('Unauthorized');

            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('updateCustomReward', () => {
        it('should update custom reward successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: 'reward-1',
                        title: 'Updated Song Request',
                        cost: 1000,
                        is_enabled: true
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const updates = {
                title: 'Updated Song Request',
                cost: 1000,
                is_enabled: true
            };

            const result = await twitchAPI.updateCustomReward('broadcaster-123', 'reward-1', updates);

            expect(result).toEqual({
                id: 'reward-1',
                title: 'Updated Song Request',
                cost: 1000,
                is_enabled: true
            });
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('channel_points/custom_rewards'),
                expect.objectContaining({
                    method: 'PATCH',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-broadcaster-token',
                        'Client-Id': 'test-client-id'
                    }),
                    body: JSON.stringify(updates)
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully updated custom reward',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    rewardId: 'reward-1',
                    updates
                })
            );
        });

        it('should handle empty data response', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                twitchAPI.updateCustomReward('broadcaster-123', 'reward-1', { cost: 500 })
            ).rejects.toThrow('Failed to update reward');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to update reward - no data returned',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    rewardId: 'reward-1'
                })
            );
        });

        it('should handle API error', async () => {
            const apiError = new Error('Unauthorized');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(
                twitchAPI.updateCustomReward('broadcaster-123', 'reward-1', { cost: 500 })
            ).rejects.toThrow('Unauthorized');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to update custom reward',
                expect.objectContaining({
                    error: 'Unauthorized',
                    broadcasterId: 'broadcaster-123',
                    rewardId: 'reward-1'
                })
            );
        });
    });

    describe('getChannelInfo', () => {
        it('should fetch channel information successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [{
                        broadcaster_id: 'broadcaster-123',
                        broadcaster_name: 'TestStreamer',
                        broadcaster_language: 'en',
                        game_id: '12345',
                        game_name: 'Just Chatting',
                        title: 'Test Stream Title'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChannelInfo('broadcaster-123');

            expect(result).toEqual({
                broadcaster_id: 'broadcaster-123',
                broadcaster_name: 'TestStreamer',
                broadcaster_language: 'en',
                game_id: '12345',
                game_name: 'Just Chatting',
                title: 'Test Stream Title'
            });
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('channels?broadcaster_id=broadcaster-123'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-broadcaster-token',
                        'Client-Id': 'test-client-id'
                    })
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully retrieved channel information',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    broadcasterName: 'TestStreamer',
                    gameId: '12345'
                })
            );
        });

        it('should return null when channel not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChannelInfo('nonexistent-123');

            expect(result).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'TwitchAPI',
                'Channel info not found',
                { broadcasterId: 'nonexistent-123' }
            );
        });

        it('should handle API error', async () => {
            const apiError = new Error('API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getChannelInfo('broadcaster-123')).rejects.toThrow('API error');

            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to get channel information',
                expect.objectContaining({
                    error: 'API error',
                    broadcasterId: 'broadcaster-123'
                })
            );
        });
    });

    describe('getChatters', () => {
        it('should fetch chatters successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    data: [
                        { user_id: 'user-1', user_login: 'user1', user_name: 'User1' },
                        { user_id: 'user-2', user_login: 'user2', user_name: 'User2' },
                        { user_id: 'user-3', user_login: 'user3', user_name: 'User3' }
                    ],
                    total: 3
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({
                user_id: 'user-1',
                user_login: 'user1',
                user_name: 'User1'
            });
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('chat/chatters?broadcaster_id=broadcaster-123&moderator_id=moderator-456'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-broadcaster-token',
                        'Client-Id': 'test-client-id'
                    })
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully retrieved chatters',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    moderatorId: 'moderator-456',
                    chatterCount: 3
                })
            );
        });

        it('should return empty array when no chatters', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
            expect(logger.info).toHaveBeenCalledWith(
                'TwitchAPI',
                'Successfully retrieved chatters',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    moderatorId: 'moderator-456',
                    chatterCount: 0
                })
            );
        });

        it('should return empty array when data.data is missing', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({})
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
            expect(logger.debug).toHaveBeenCalledWith(
                'TwitchAPI',
                'No chatters found',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    moderatorId: 'moderator-456'
                })
            );
        });

        it('should return empty array on error', async () => {
            const apiError = new Error('Chatters API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
            expect(logger.error).toHaveBeenCalledWith(
                'TwitchAPI',
                'Failed to get chatters',
                expect.objectContaining({
                    error: 'Chatters API error',
                    broadcasterId: 'broadcaster-123',
                    moderatorId: 'moderator-456'
                })
            );
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple API calls in sequence', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: '123',
                        login: 'user',
                        display_name: 'User'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await twitchAPI.getUserByName('user1');
            await twitchAPI.getUserByName('user2');
            await twitchAPI.getUserByName('user3');

            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it('should handle alternating success and failure', async () => {
            const successResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{ id: '123', login: 'user', display_name: 'User' }]
                })
            };
            const errorResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };

            fetch
                .mockResolvedValueOnce(successResponse)
                .mockResolvedValueOnce(errorResponse)
                .mockResolvedValueOnce(successResponse);

            const result1 = await twitchAPI.getUserByName('user1');
            const result2 = await twitchAPI.getUserByName('user2');
            const result3 = await twitchAPI.getUserByName('user3');

            expect(result1).not.toBeNull();
            expect(result2).toBeNull();
            expect(result3).not.toBeNull();
        });
    });
});
