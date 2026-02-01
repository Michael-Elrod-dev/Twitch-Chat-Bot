// tests/websocket/webSocketManager.test.js

const WebSocketManager = require('../../src/websocket/webSocketManager');

jest.mock('ws');

jest.mock('../../src/config/config', () => ({
    wsEndpoint: 'wss://test.twitch.tv/ws',
    wsReconnectDelay: 1000
}));

const WebSocket = require('ws');

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
        });
    });

    describe('connect', () => {
        it('should create WebSocket connection', async () => {
            await webSocketManager.connect();

            expect(WebSocket).toHaveBeenCalledWith('wss://test.twitch.tv/ws');
            expect(webSocketManager.wsConnection).toBe(mockWsInstance);
        });

        it('should register event handlers', async () => {
            await webSocketManager.connect();

            expect(mockWsInstance.on).toHaveBeenCalledWith('close', expect.any(Function));
            expect(mockWsInstance.on).toHaveBeenCalledWith('message', expect.any(Function));
            expect(mockWsInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('should handle connection error', async () => {
            const connectionError = new Error('Connection failed');
            WebSocket.mockImplementation(() => {
                throw connectionError;
            });

            await expect(webSocketManager.connect()).rejects.toThrow('Connection failed');
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
        });

        it('should handle session_keepalive message', async () => {
            const keepaliveMessage = {
                metadata: {
                    message_type: 'session_keepalive'
                }
            };

            await webSocketManager.handleMessage(keepaliveMessage);

            // Keepalive message handled successfully (no error thrown)
        });

        it('should handle session_reconnect message', async () => {
            const reconnectMessage = {
                metadata: {
                    message_type: 'session_reconnect'
                }
            };

            const connectSpy = jest.spyOn(webSocketManager, 'connect').mockResolvedValue(true);

            await webSocketManager.handleMessage(reconnectMessage);

            expect(connectSpy).toHaveBeenCalled();
        });

        it('should handle unknown message type', async () => {
            const unknownMessage = {
                metadata: {
                    message_type: 'unknown_type'
                }
            };

            await webSocketManager.handleMessage(unknownMessage);

            // Unknown message type handled gracefully (no error thrown)
        });

        it('should handle message without metadata', async () => {
            const invalidMessage = {
                payload: {}
            };

            await webSocketManager.handleMessage(invalidMessage);

            // Invalid message handled gracefully (no error thrown)
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

            // Missing handler handled gracefully (no error thrown)
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

            // Handler error handled gracefully (no error thrown)
        });
    });

    describe('close', () => {
        it('should close WebSocket connection', async () => {
            await webSocketManager.connect();

            webSocketManager.close();

            expect(mockWsInstance.close).toHaveBeenCalled();
        });

        it('should handle close when no connection exists', () => {
            webSocketManager.close();

            // No error thrown when closing without connection
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
