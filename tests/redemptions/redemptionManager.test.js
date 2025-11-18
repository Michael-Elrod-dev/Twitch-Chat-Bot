// tests/redemptions/redemptionManager.test.js

const RedemptionManager = require('../../src/redemptions/redemptionManager');

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

describe('RedemptionManager', () => {
    let redemptionManager;
    let mockTwitchBot;
    let mockSpotifyManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockTwitchBot = {
            tokenManager: {
                tokens: {
                    clientId: 'test-client-id',
                    broadcasterAccessToken: 'test-broadcaster-token'
                }
            }
        };

        mockSpotifyManager = {
            spotifyApi: {},
            queueManager: {}
        };

        redemptionManager = new RedemptionManager(mockTwitchBot, mockSpotifyManager);
    });

    describe('constructor', () => {
        it('should initialize with twitch bot and spotify manager', () => {
            expect(redemptionManager.twitchBot).toBe(mockTwitchBot);
            expect(redemptionManager.spotifyManager).toBe(mockSpotifyManager);
            expect(redemptionManager.handlers).toBeInstanceOf(Map);
        });

        it('should initialize empty handlers map', () => {
            expect(redemptionManager.handlers.size).toBe(0);
        });
    });

    describe('registerHandler', () => {
        it('should register handler for reward title', () => {
            const mockHandler = jest.fn();

            redemptionManager.registerHandler('Song Request', mockHandler);

            expect(redemptionManager.handlers.get('song request')).toBe(mockHandler);
            expect(logger.info).toHaveBeenCalledWith(
                'RedemptionManager',
                'Handler registered',
                { rewardTitle: 'Song Request' }
            );
        });

        it('should convert reward title to lowercase', () => {
            const mockHandler = jest.fn();

            redemptionManager.registerHandler('SONG REQUEST', mockHandler);

            expect(redemptionManager.handlers.get('song request')).toBe(mockHandler);
        });

        it('should allow multiple handlers', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            redemptionManager.registerHandler('Song Request', handler1);
            redemptionManager.registerHandler('Quote Add', handler2);

            expect(redemptionManager.handlers.size).toBe(2);
            expect(redemptionManager.handlers.get('song request')).toBe(handler1);
            expect(redemptionManager.handlers.get('quote add')).toBe(handler2);
        });

        it('should overwrite existing handler for same reward', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            redemptionManager.registerHandler('Song Request', handler1);
            redemptionManager.registerHandler('Song Request', handler2);

            expect(redemptionManager.handlers.get('song request')).toBe(handler2);
        });
    });

    describe('handleRedemption', () => {
        it('should execute registered handler successfully', async () => {
            const mockHandler = jest.fn().mockResolvedValue(true);
            const event = {
                rewardTitle: 'Song Request',
                userId: 'user-123',
                userDisplayName: 'testuser',
                input: 'Test input',
                rewardId: 'reward-123',
                status: 'unfulfilled'
            };

            redemptionManager.registerHandler('Song Request', mockHandler);
            await redemptionManager.handleRedemption(event);

            expect(mockHandler).toHaveBeenCalledWith(
                event,
                mockTwitchBot,
                mockSpotifyManager,
                mockTwitchBot
            );
            expect(logger.info).toHaveBeenCalledWith(
                'RedemptionManager',
                'Handler executed successfully',
                expect.objectContaining({
                    rewardTitle: 'Song Request',
                    userId: 'user-123',
                    userDisplayName: 'testuser'
                })
            );
        });

        it('should be case insensitive when matching handlers', async () => {
            const mockHandler = jest.fn().mockResolvedValue(true);
            const event = {
                rewardTitle: 'SONG REQUEST',
                userId: 'user-123',
                userDisplayName: 'testuser'
            };

            redemptionManager.registerHandler('song request', mockHandler);
            await redemptionManager.handleRedemption(event);

            expect(mockHandler).toHaveBeenCalled();
        });

        it('should warn when no handler found', async () => {
            const event = {
                rewardTitle: 'Unknown Reward',
                userId: 'user-123',
                userDisplayName: 'testuser'
            };

            await redemptionManager.handleRedemption(event);

            expect(logger.warn).toHaveBeenCalledWith(
                'RedemptionManager',
                'No handler found for reward',
                expect.objectContaining({
                    rewardTitle: 'Unknown Reward',
                    userId: 'user-123',
                    userDisplayName: 'testuser'
                })
            );
        });

        it('should not throw when no handler found', async () => {
            const event = {
                rewardTitle: 'Unknown Reward',
                userId: 'user-123',
                userDisplayName: 'testuser'
            };

            await expect(
                redemptionManager.handleRedemption(event)
            ).resolves.not.toThrow();
        });

        it('should handle handler execution error gracefully', async () => {
            const mockHandler = jest.fn().mockRejectedValue(new Error('Handler failed'));
            const event = {
                rewardTitle: 'Song Request',
                userId: 'user-123',
                userDisplayName: 'testuser',
                rewardId: 'reward-123',
                status: 'unfulfilled',
                input: 'Test input'
            };

            redemptionManager.registerHandler('Song Request', mockHandler);
            await redemptionManager.handleRedemption(event);

            expect(logger.error).toHaveBeenCalledWith(
                'RedemptionManager',
                'Handler execution failed',
                expect.objectContaining({
                    error: 'Handler failed',
                    rewardTitle: 'Song Request',
                    userDisplayName: 'testuser',
                    rewardId: 'reward-123',
                    status: 'unfulfilled',
                    input: 'Test input'
                })
            );
        });

        it('should not throw when handler fails', async () => {
            const mockHandler = jest.fn().mockRejectedValue(new Error('Handler failed'));
            const event = {
                rewardTitle: 'Song Request',
                userId: 'user-123',
                userDisplayName: 'testuser',
                rewardId: 'reward-123',
                status: 'unfulfilled',
                input: 'Test input'
            };

            redemptionManager.registerHandler('Song Request', mockHandler);

            await expect(
                redemptionManager.handleRedemption(event)
            ).resolves.not.toThrow();
        });
    });

    describe('updateRedemptionStatus', () => {
        it('should update redemption status successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await redemptionManager.updateRedemptionStatus(
                'broadcaster-123',
                'reward-456',
                ['redemption-789'],
                'FULFILLED'
            );

            expect(fetch).toHaveBeenCalledWith(
                'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=broadcaster-123&reward_id=reward-456&id=redemption-789',
                expect.objectContaining({
                    method: 'PATCH',
                    headers: {
                        'Client-Id': 'test-client-id',
                        'Authorization': 'Bearer test-broadcaster-token',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ status: 'FULFILLED' })
                })
            );
        });

        it('should handle CANCELED status', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await redemptionManager.updateRedemptionStatus(
                'broadcaster-123',
                'reward-456',
                ['redemption-789'],
                'CANCELED'
            );

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);
            expect(body.status).toBe('CANCELED');
        });

        it('should throw error on API failure', async () => {
            const errorData = {
                error: 'Bad Request',
                status: 400,
                message: 'Invalid redemption ID'
            };
            const mockResponse = {
                ok: false,
                status: 400,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                redemptionManager.updateRedemptionStatus(
                    'broadcaster-123',
                    'reward-456',
                    ['redemption-789'],
                    'FULFILLED'
                )
            ).rejects.toThrow('Failed to update redemption status');

            expect(logger.error).toHaveBeenCalledWith(
                'RedemptionManager',
                'Failed to update redemption status',
                expect.objectContaining({
                    broadcasterId: 'broadcaster-123',
                    rewardId: 'reward-456',
                    status: 'FULFILLED'
                })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            fetch.mockRejectedValue(networkError);

            await expect(
                redemptionManager.updateRedemptionStatus(
                    'broadcaster-123',
                    'reward-456',
                    ['redemption-789'],
                    'FULFILLED'
                )
            ).rejects.toThrow('Network request failed');

            expect(logger.error).toHaveBeenCalled();
        });

        it('should handle unauthorized error (401)', async () => {
            const errorData = {
                error: 'Unauthorized',
                status: 401
            };
            const mockResponse = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                redemptionManager.updateRedemptionStatus(
                    'broadcaster-123',
                    'reward-456',
                    ['redemption-789'],
                    'FULFILLED'
                )
            ).rejects.toThrow();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete redemption flow', async () => {
            const mockHandler = jest.fn().mockResolvedValue(true);
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const event = {
                rewardTitle: 'Song Request',
                userId: 'user-123',
                userDisplayName: 'testuser',
                broadcasterId: 'broadcaster-123',
                rewardId: 'reward-456',
                id: 'redemption-789',
                input: 'Test song',
                status: 'unfulfilled'
            };

            redemptionManager.registerHandler('Song Request', async (evt) => {
                await redemptionManager.updateRedemptionStatus(
                    evt.broadcasterId,
                    evt.rewardId,
                    [evt.id],
                    'FULFILLED'
                );
            });

            await redemptionManager.handleRedemption(event);

            expect(fetch).toHaveBeenCalled();
        });

        it('should handle multiple redemptions in sequence', async () => {
            const mockHandler = jest.fn().mockResolvedValue(true);
            redemptionManager.registerHandler('Test Reward', mockHandler);

            await redemptionManager.handleRedemption({
                rewardTitle: 'Test Reward',
                userId: 'user-1',
                userDisplayName: 'user1'
            });

            await redemptionManager.handleRedemption({
                rewardTitle: 'Test Reward',
                userId: 'user-2',
                userDisplayName: 'user2'
            });

            await redemptionManager.handleRedemption({
                rewardTitle: 'Test Reward',
                userId: 'user-3',
                userDisplayName: 'user3'
            });

            expect(mockHandler).toHaveBeenCalledTimes(3);
        });
    });
});
