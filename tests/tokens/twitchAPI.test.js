// tests/tokens/twitchAPI.test.js

const TwitchAPI = require('../../src/tokens/twitchAPI');

jest.mock('node-fetch');

jest.mock('../../src/config/config', () => ({
    twitchApiEndpoint: 'https://api.twitch.tv/helix'
}));

const fetch = require('node-fetch');

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
        });

        it('should throw error when user not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(twitchAPI.getChannelId('nonexistentuser')).rejects.toThrow('User not found');
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(twitchAPI.getChannelId('testuser')).rejects.toThrow('Network request failed');
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
        });

        it('should return null when stream is offline', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getStreamByUserName('teststreamer');

            expect(result).toBeNull();
        });

        it('should handle API error', async () => {
            const apiError = new Error('API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getStreamByUserName('teststreamer')).rejects.toThrow('API error');
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
        });

        it('should return null when user not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getUserByName('nonexistentuser');

            expect(result).toBeNull();
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network error');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(twitchAPI.getUserByName('testuser')).rejects.toThrow('Network error');
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
        });

        it('should handle API error', async () => {
            const apiError = new Error('Unauthorized');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getCustomRewards('broadcaster-123')).rejects.toThrow('Unauthorized');
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
        });

        it('should handle API error', async () => {
            const apiError = new Error('Unauthorized');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(
                twitchAPI.updateCustomReward('broadcaster-123', 'reward-1', { cost: 500 })
            ).rejects.toThrow('Unauthorized');
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
        });

        it('should return null when channel not found', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChannelInfo('nonexistent-123');

            expect(result).toBeNull();
        });

        it('should handle API error', async () => {
            const apiError = new Error('API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            await expect(twitchAPI.getChannelInfo('broadcaster-123')).rejects.toThrow('API error');
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
        });

        it('should return empty array when no chatters', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
        });

        it('should return empty array when data.data is missing', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({})
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
        });

        it('should return empty array on error', async () => {
            const apiError = new Error('Chatters API error');
            apiError.stack = 'Error stack';
            fetch.mockRejectedValue(apiError);

            const result = await twitchAPI.getChatters('broadcaster-123', 'moderator-456');

            expect(result).toEqual([]);
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
