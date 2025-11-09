// tests/websocket/webSocketManager.test.js

const WebSocketManager = require('../../src/websocket/webSocketManager');

// Mock WebSocket
jest.mock('ws');

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

// Mock config
jest.mock('../../src/config/config', () => ({
    wsEndpoint: 'wss://test.twitch.tv/ws',
    wsReconnectDelay: 1000
}));

const WebSocket = require('ws');
const logger = require('../../src/logger/logger');

describe('WebSocketManager', () => {
    let webSocketManager;
    let mockTokenManager;
    let mockChatHandler;
    let mockRedemptionHandler;
    let mockStreamOnlineHandler;
    let mockStreamOfflineHandler;
    let mockWsInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockTokenManager = {
            tokens: {
                clientId: 'test-client-id',
                broadcasterAccessToken: 'test-token'
            }
        };

        mockChatHandler = jest.fn().mockResolvedValue(true);
        mockRedemptionHandler = jest.fn().mockResolvedValue(true);
        mockStreamOnlineHandler = jest.fn().mockResolvedValue(true);
        mockStreamOfflineHandler = jest.fn().mockResolvedValue(true);

        mockWsInstance = {
            on: jest.fn(),
            close: jest.fn()
        };

        WebSocket.mockImplementation(() => mockWsInstance);

        webSocketManager = new WebSocketManager(
            mockTokenManager,
            mockChatHandler,
            mockRedemptionHandler,
            mockStreamOnlineHandler,
            mockStreamOfflineHandler
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with handlers', () => {
            expect(webSocketManager.tokenManager).toBe(mockTokenManager);
            expect(webSocketManager.chatHandler).toBe(mockChatHandler);
            expect(webSocketManager.redemptionHandler).toBe(mockRedemptionHandler);
            expect(webSocketManager.streamOnlineHandler).toBe(mockStreamOnlineHandler);
            expect(webSocketManager.streamOfflineHandler).toBe(mockStreamOfflineHandler);
            expect(webSocketManager.wsConnection).toBeNull();
            expect(webSocketManager.sessionId).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'WebSocketManager',
                'WebSocketManager instance created'
            );
        });
    });

    describe('connect', () => {
        it('should create WebSocket connection', async () => {
            await webSocketManager.connect();

            expect(WebSocket).toHaveBeenCalledWith('wss://test.twitch.tv/ws');
            expect(webSocketManager.wsConnection).toBe(mockWsInstance);
            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'Connecting to WebSocket',
                expect.objectContaining({ endpoint: 'wss://test.twitch.tv/ws' })
            );
        });

        it('should register event handlers', async () => {
            await webSocketManager.connect();

            expect(mockWsInstance.on).toHaveBeenCalledWith('close', expect.any(Function));
            expect(mockWsInstance.on).toHaveBeenCalledWith('message', expect.any(Function));
            expect(mockWsInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
            expect(logger.debug).toHaveBeenCalledWith(
                'WebSocketManager',
                'WebSocket event handlers registered'
            );
        });

        it('should handle connection error', async () => {
            const connectionError = new Error('Connection failed');
            WebSocket.mockImplementation(() => {
                throw connectionError;
            });

            await expect(webSocketManager.connect()).rejects.toThrow('Connection failed');

            expect(logger.error).toHaveBeenCalledWith(
                'WebSocketManager',
                'Failed to connect to WebSocket',
                expect.objectContaining({
                    error: 'Connection failed'
                })
            );
        });
    });

    describe('handleMessage', () => {
        beforeEach(async () => {
            await webSocketManager.connect();
        });

        it('should handle session_welcome message', async () => {
            const welcomeMessage = {
                metadata: {
                    message_type: 'session_welcome'
                },
                payload: {
                    session: {
                        id: 'session-123'
                    }
                }
            };

            await webSocketManager.handleMessage(welcomeMessage);

            expect(webSocketManager.sessionId).toBe('session-123');
            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'WebSocket session established',
                expect.objectContaining({ sessionId: 'session-123' })
            );
        });

        it('should trigger onSessionReady callback', async () => {
            const mockCallback = jest.fn().mockResolvedValue(true);
            webSocketManager.onSessionReady = mockCallback;

            const welcomeMessage = {
                metadata: {
                    message_type: 'session_welcome'
                },
                payload: {
                    session: {
                        id: 'session-123'
                    }
                }
            };

            await webSocketManager.handleMessage(welcomeMessage);

            expect(mockCallback).toHaveBeenCalledWith('session-123');
            expect(logger.debug).toHaveBeenCalledWith(
                'WebSocketManager',
                'Triggering session ready callback'
            );
        });

        it('should handle chat message notification', async () => {
            const chatMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'channel.chat.message'
                },
                payload: {
                    event: {
                        message: {
                            text: 'Hello chat!'
                        }
                    }
                }
            };

            await webSocketManager.handleMessage(chatMessage);

            expect(mockChatHandler).toHaveBeenCalledWith(chatMessage.payload);
        });

        it('should handle redemption notification', async () => {
            const redemptionMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'channel.channel_points_custom_reward_redemption.add'
                },
                payload: {
                    event: {
                        reward: {
                            title: 'Test Reward'
                        }
                    }
                }
            };

            await webSocketManager.handleMessage(redemptionMessage);

            expect(mockRedemptionHandler).toHaveBeenCalledWith(redemptionMessage.payload);
        });

        it('should handle stream online notification', async () => {
            const streamOnlineMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'stream.online'
                },
                payload: {}
            };

            await webSocketManager.handleMessage(streamOnlineMessage);

            expect(mockStreamOnlineHandler).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received stream online event'
            );
        });

        it('should handle stream offline notification', async () => {
            const streamOfflineMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'stream.offline'
                },
                payload: {}
            };

            await webSocketManager.handleMessage(streamOfflineMessage);

            expect(mockStreamOfflineHandler).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received stream offline event'
            );
        });

        it('should handle session_keepalive message', async () => {
            const keepaliveMessage = {
                metadata: {
                    message_type: 'session_keepalive'
                }
            };

            await webSocketManager.handleMessage(keepaliveMessage);

            expect(logger.debug).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received keepalive'
            );
        });

        it('should handle session_reconnect message', async () => {
            const reconnectMessage = {
                metadata: {
                    message_type: 'session_reconnect'
                }
            };

            const connectSpy = jest.spyOn(webSocketManager, 'connect').mockResolvedValue(true);

            await webSocketManager.handleMessage(reconnectMessage);

            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'Server requested reconnection'
            );
            expect(connectSpy).toHaveBeenCalled();
        });

        it('should handle unknown message type', async () => {
            const unknownMessage = {
                metadata: {
                    message_type: 'unknown_type'
                }
            };

            await webSocketManager.handleMessage(unknownMessage);

            expect(logger.warn).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received unknown message type',
                expect.objectContaining({ messageType: 'unknown_type' })
            );
        });

        it('should handle message without metadata', async () => {
            const invalidMessage = {
                payload: {}
            };

            await webSocketManager.handleMessage(invalidMessage);

            expect(logger.error).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received message without metadata',
                expect.any(Object)
            );
        });

        it('should handle missing chat handler gracefully', async () => {
            webSocketManager.chatHandler = null;

            const chatMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'channel.chat.message'
                },
                payload: {}
            };

            await webSocketManager.handleMessage(chatMessage);

            expect(logger.debug).toHaveBeenCalledWith(
                'WebSocketManager',
                'Received chat message but no handler registered'
            );
        });

        it('should handle handler error gracefully', async () => {
            const handlerError = new Error('Handler failed');
            handlerError.stack = 'Error stack';
            mockChatHandler.mockRejectedValue(handlerError);

            const chatMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'channel.chat.message'
                },
                payload: {}
            };

            await webSocketManager.handleMessage(chatMessage);

            expect(logger.error).toHaveBeenCalledWith(
                'WebSocketManager',
                'Error handling WebSocket message',
                expect.objectContaining({
                    error: 'Handler failed'
                })
            );
        });
    });

    describe('close', () => {
        it('should close WebSocket connection', async () => {
            await webSocketManager.connect();

            webSocketManager.close();

            expect(mockWsInstance.close).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'WebSocketManager',
                'Closing WebSocket connection'
            );
        });

        it('should handle close when no connection exists', () => {
            webSocketManager.close();

            expect(logger.info).not.toHaveBeenCalled();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete session lifecycle', async () => {
            await webSocketManager.connect();

            const welcomeMessage = {
                metadata: { message_type: 'session_welcome' },
                payload: { session: { id: 'session-123' } }
            };

            await webSocketManager.handleMessage(welcomeMessage);

            const chatMessage = {
                metadata: {
                    message_type: 'notification',
                    subscription_type: 'channel.chat.message'
                },
                payload: { event: { message: { text: 'Test' } } }
            };

            await webSocketManager.handleMessage(chatMessage);

            webSocketManager.close();

            expect(webSocketManager.sessionId).toBe('session-123');
            expect(mockChatHandler).toHaveBeenCalled();
            expect(mockWsInstance.close).toHaveBeenCalled();
        });

        it('should handle multiple message types in sequence', async () => {
            await webSocketManager.connect();

            const messages = [
                {
                    metadata: { message_type: 'session_welcome' },
                    payload: { session: { id: 'session-123' } }
                },
                {
                    metadata: { message_type: 'session_keepalive' }
                },
                {
                    metadata: {
                        message_type: 'notification',
                        subscription_type: 'channel.chat.message'
                    },
                    payload: {}
                }
            ];

            for (const message of messages) {
                await webSocketManager.handleMessage(message);
            }

            expect(mockChatHandler).toHaveBeenCalledTimes(1);
        });
    });
});
