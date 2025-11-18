// tests/websocket/subscriptionManager.test.js

const SubscriptionManager = require('../../src/websocket/subscriptionManager');

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

describe('SubscriptionManager', () => {
    let subscriptionManager;
    let mockTokenManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockTokenManager = {
            tokens: {
                channelId: 'channel-123',
                userId: 'user-456',
                clientId: 'client-789',
                broadcasterAccessToken: 'broadcaster-token-abc'
            }
        };

        subscriptionManager = new SubscriptionManager(mockTokenManager, 'session-xyz');
    });

    describe('constructor', () => {
        it('should initialize with token manager and session ID', () => {
            expect(subscriptionManager.tokenManager).toBe(mockTokenManager);
            expect(subscriptionManager.sessionId).toBe('session-xyz');
            expect(logger.debug).toHaveBeenCalledWith(
                'SubscriptionManager',
                'SubscriptionManager instance created',
                expect.objectContaining({ sessionId: 'session-xyz' })
            );
        });
    });

    describe('setSessionId', () => {
        it('should update session ID', () => {
            subscriptionManager.setSessionId('new-session-123');

            expect(subscriptionManager.sessionId).toBe('new-session-123');
            expect(logger.debug).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Session ID updated',
                expect.objectContaining({
                    oldSessionId: 'session-xyz',
                    newSessionId: 'new-session-123'
                })
            );
        });
    });

    describe('subscribeToChatEvents', () => {
        it('should subscribe to chat events successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: 'subscription-123',
                        status: 'enabled'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToChatEvents();

            expect(fetch).toHaveBeenCalledWith(
                'https://api.twitch.tv/helix/eventsub/subscriptions',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Client-Id': 'client-789',
                        'Authorization': 'Bearer broadcaster-token-abc',
                        'Content-Type': 'application/json'
                    },
                    body: expect.stringContaining('channel.chat.message')
                })
            );

            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Subscribed to chat events',
                expect.objectContaining({ subscriptionId: 'subscription-123' })
            );
        });

        it('should include correct subscription parameters', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [{}] })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToChatEvents();

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);

            expect(body).toEqual({
                type: 'channel.chat.message',
                version: '1',
                condition: {
                    broadcaster_user_id: 'channel-123',
                    user_id: 'user-456'
                },
                transport: {
                    method: 'websocket',
                    session_id: 'session-xyz'
                }
            });
        });

        it('should throw error when missing required IDs', async () => {
            mockTokenManager.tokens.channelId = null;

            await expect(subscriptionManager.subscribeToChatEvents()).rejects.toThrow('Missing required IDs');
        });

        it('should handle API error response', async () => {
            const errorData = {
                error: 'Unauthorized',
                status: 401,
                message: 'Invalid token'
            };
            const mockResponse = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(subscriptionManager.subscribeToChatEvents()).rejects.toThrow(
                'Failed to subscribe to chat events'
            );

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to subscribe to chat events',
                expect.objectContaining({
                    status: 401,
                    error: JSON.stringify(errorData)
                })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(subscriptionManager.subscribeToChatEvents()).rejects.toThrow('Network request failed');

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Error subscribing to chat events',
                expect.objectContaining({
                    error: 'Network request failed'
                })
            );
        });
    });

    describe('subscribeToChannelPoints', () => {
        it('should subscribe to channel point redemptions successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: 'subscription-456',
                        status: 'enabled'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToChannelPoints();

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);

            expect(body.type).toBe('channel.channel_points_custom_reward_redemption.add');
            expect(body.condition.broadcaster_user_id).toBe('channel-123');
            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Subscribed to channel point redemptions',
                expect.objectContaining({ subscriptionId: 'subscription-456' })
            );
        });

        it('should throw error when missing required IDs', async () => {
            mockTokenManager.tokens.userId = null;

            await expect(subscriptionManager.subscribeToChannelPoints()).rejects.toThrow('Missing required IDs');
        });

        it('should handle API error', async () => {
            const mockResponse = {
                ok: false,
                status: 403,
                json: jest.fn().mockResolvedValue({ error: 'Forbidden' })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(subscriptionManager.subscribeToChannelPoints()).rejects.toThrow(
                'Failed to subscribe to channel points'
            );

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to subscribe to channel points',
                expect.objectContaining({ status: 403 })
            );
        });
    });

    describe('subscribeToStreamOnline', () => {
        it('should subscribe to stream online events successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: 'subscription-789',
                        status: 'enabled'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToStreamOnline();

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);

            expect(body.type).toBe('stream.online');
            expect(body.condition.broadcaster_user_id).toBe('channel-123');
            expect(logger.debug).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Subscribing to stream online events'
            );
        });

        it('should throw error when missing channel ID', async () => {
            mockTokenManager.tokens.channelId = null;

            await expect(subscriptionManager.subscribeToStreamOnline()).rejects.toThrow('Missing required channel ID');
        });

        it('should handle API error', async () => {
            const mockResponse = {
                ok: false,
                status: 500,
                json: jest.fn().mockResolvedValue({ error: 'Server error' })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(subscriptionManager.subscribeToStreamOnline()).rejects.toThrow();

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to subscribe to stream online events',
                expect.objectContaining({ status: 500 })
            );
        });
    });

    describe('subscribeToStreamOffline', () => {
        it('should subscribe to stream offline events successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [{
                        id: 'subscription-offline-123',
                        status: 'enabled'
                    }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToStreamOffline();

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);

            expect(body.type).toBe('stream.offline');
            expect(body.condition.broadcaster_user_id).toBe('channel-123');
            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Subscribed to stream offline events',
                expect.objectContaining({ subscriptionId: 'subscription-offline-123' })
            );
        });

        it('should throw error when missing channel ID', async () => {
            mockTokenManager.tokens.channelId = null;

            await expect(subscriptionManager.subscribeToStreamOffline()).rejects.toThrow('Missing required channel ID');
        });

        it('should handle API error', async () => {
            const mockResponse = {
                ok: false,
                status: 500,
                json: jest.fn().mockResolvedValue({ error: 'Server error' })
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(subscriptionManager.subscribeToStreamOffline()).rejects.toThrow();

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to subscribe to stream offline events',
                expect.objectContaining({ status: 500 })
            );
        });
    });

    describe('unsubscribeFromChatEvents', () => {
        it('should unsubscribe from chat events successfully', async () => {
            const getResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [
                        {
                            id: 'sub-123',
                            type: 'channel.chat.message',
                            transport: { session_id: 'session-xyz' }
                        }
                    ]
                })
            };

            const deleteResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({})
            };

            fetch
                .mockResolvedValueOnce(getResponse)
                .mockResolvedValueOnce(deleteResponse);

            await subscriptionManager.unsubscribeFromChatEvents();

            expect(fetch).toHaveBeenCalledTimes(2);
            expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('eventsub/subscriptions'), {
                method: 'GET',
                headers: expect.objectContaining({
                    'Client-Id': 'client-789',
                    'Authorization': 'Bearer broadcaster-token-abc'
                })
            });
            expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('id=sub-123'), {
                method: 'DELETE',
                headers: expect.any(Object)
            });
            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Successfully unsubscribed',
                expect.objectContaining({
                    eventType: 'channel.chat.message',
                    subscriptionId: 'sub-123'
                })
            );
        });

        it('should handle when no subscription found', async () => {
            const getResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: []
                })
            };

            fetch.mockResolvedValue(getResponse);

            await subscriptionManager.unsubscribeFromChatEvents();

            expect(fetch).toHaveBeenCalledTimes(1); // Only GET, no DELETE
            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'No subscription found to unsubscribe',
                expect.objectContaining({
                    eventType: 'channel.chat.message',
                    sessionId: 'session-xyz'
                })
            );
        });

        it('should handle error', async () => {
            const error = new Error('Unsubscribe failed');
            error.stack = 'Error stack';
            fetch.mockRejectedValue(error);

            await expect(subscriptionManager.unsubscribeFromChatEvents()).rejects.toThrow('Unsubscribe failed');

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Error unsubscribing from chat events',
                expect.objectContaining({ error: 'Unsubscribe failed' })
            );
        });
    });

    describe('unsubscribeFromChannelPoints', () => {
        it('should unsubscribe from channel points successfully', async () => {
            const getResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [
                        {
                            id: 'sub-points-123',
                            type: 'channel.channel_points_custom_reward_redemption.add',
                            transport: { session_id: 'session-xyz' }
                        }
                    ]
                })
            };

            const deleteResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({})
            };

            fetch
                .mockResolvedValueOnce(getResponse)
                .mockResolvedValueOnce(deleteResponse);

            await subscriptionManager.unsubscribeFromChannelPoints();

            expect(logger.info).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Successfully unsubscribed',
                expect.objectContaining({
                    eventType: 'channel.channel_points_custom_reward_redemption.add'
                })
            );
        });

        it('should handle error', async () => {
            const error = new Error('Points unsubscribe failed');
            error.stack = 'Error stack';
            fetch.mockRejectedValue(error);

            await expect(subscriptionManager.unsubscribeFromChannelPoints()).rejects.toThrow('Points unsubscribe failed');

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Error unsubscribing from channel points',
                expect.objectContaining({ error: 'Points unsubscribe failed' })
            );
        });
    });

    describe('unsubscribeFromEventType', () => {
        it('should handle fetch subscriptions error', async () => {
            const getResponse = {
                ok: false,
                status: 403,
                json: jest.fn().mockResolvedValue({ error: 'Forbidden' })
            };

            fetch.mockResolvedValue(getResponse);

            await expect(
                subscriptionManager.unsubscribeFromChatEvents()
            ).rejects.toThrow('Failed to get subscriptions');

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to fetch subscriptions',
                expect.objectContaining({ status: 403 })
            );
        });

        it('should handle delete subscription error', async () => {
            const getResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [
                        {
                            id: 'sub-123',
                            type: 'channel.chat.message',
                            transport: { session_id: 'session-xyz' }
                        }
                    ]
                })
            };

            const deleteResponse = {
                ok: false,
                status: 404,
                json: jest.fn().mockResolvedValue({ error: 'Not found' })
            };

            fetch
                .mockResolvedValueOnce(getResponse)
                .mockResolvedValueOnce(deleteResponse);

            await expect(
                subscriptionManager.unsubscribeFromChatEvents()
            ).rejects.toThrow('Failed to delete subscription');

            expect(logger.error).toHaveBeenCalledWith(
                'SubscriptionManager',
                'Failed to delete subscription',
                expect.objectContaining({
                    subscriptionId: 'sub-123',
                    status: 404
                })
            );
        });

        it('should filter subscriptions by session ID', async () => {
            const getResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [
                        {
                            id: 'sub-wrong-session',
                            type: 'channel.chat.message',
                            transport: { session_id: 'different-session' }
                        },
                        {
                            id: 'sub-correct-session',
                            type: 'channel.chat.message',
                            transport: { session_id: 'session-xyz' }
                        }
                    ]
                })
            };

            const deleteResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({})
            };

            fetch
                .mockResolvedValueOnce(getResponse)
                .mockResolvedValueOnce(deleteResponse);

            await subscriptionManager.unsubscribeFromChatEvents();

            expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('id=sub-correct-session'), expect.any(Object));
        });
    });

    describe('Integration scenarios', () => {
        it('should subscribe to multiple event types in sequence', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [{ id: 'sub-123' }] })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToChatEvents();
            await subscriptionManager.subscribeToChannelPoints();
            await subscriptionManager.subscribeToStreamOnline();

            expect(fetch).toHaveBeenCalledTimes(3);
            expect(logger.info).toHaveBeenCalled();
        });

        it('should handle session ID update mid-flow', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [{}] })
            };
            fetch.mockResolvedValue(mockResponse);

            await subscriptionManager.subscribeToChatEvents();

            subscriptionManager.setSessionId('new-session-456');

            await subscriptionManager.subscribeToChannelPoints();

            const firstCall = JSON.parse(fetch.mock.calls[0][1].body);
            const secondCall = JSON.parse(fetch.mock.calls[1][1].body);

            expect(firstCall.transport.session_id).toBe('session-xyz');
            expect(secondCall.transport.session_id).toBe('new-session-456');
        });

        it('should handle alternating success and failure', async () => {
            const successResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [{ id: 'sub-123' }] })
            };
            const errorResponse = {
                ok: false,
                status: 400,
                json: jest.fn().mockResolvedValue({ error: 'Bad request' })
            };

            fetch
                .mockResolvedValueOnce(successResponse)
                .mockResolvedValueOnce(errorResponse)
                .mockResolvedValueOnce(successResponse);

            await subscriptionManager.subscribeToChatEvents();

            await expect(subscriptionManager.subscribeToChannelPoints()).rejects.toThrow();

            await subscriptionManager.subscribeToStreamOnline();

            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });
});
