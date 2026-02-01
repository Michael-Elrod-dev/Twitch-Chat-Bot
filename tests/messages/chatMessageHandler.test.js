// tests/messages/chatMessageHandler.test.js

const ChatMessageHandler = require('../../src/messages/chatMessageHandler');

jest.mock('../../src/config/config', () => ({
    cache: {
        aiEnabledTTL: 60
    }
}));

const { createMockRedisManager } = require('../__mocks__/mockRedisManager');

describe('ChatMessageHandler', () => {
    let chatMessageHandler;
    let mockViewerManager;
    let mockCommandManager;
    let mockEmoteManager;
    let mockAiManager;
    let mockRedisManager;
    let mockBot;

    beforeEach(() => {
        mockViewerManager = {
            trackInteraction: jest.fn().mockResolvedValue(undefined)
        };

        mockCommandManager = {
            handleCommand: jest.fn().mockResolvedValue(undefined)
        };

        mockEmoteManager = {
            getEmoteResponse: jest.fn().mockResolvedValue(null)
        };

        mockAiManager = {
            shouldTriggerText: jest.fn().mockReturnValue(false),
            extractPrompt: jest.fn(),
            handleTextRequest: jest.fn().mockResolvedValue({ success: true, response: 'AI response' })
        };

        mockRedisManager = createMockRedisManager(true);

        mockBot = {
            tokenManager: {
                tokens: {
                    botId: 'bot123'
                }
            },
            currentStreamId: 'stream456',
            channelName: 'testchannel',
            sendMessage: jest.fn().mockResolvedValue(undefined),
            analyticsManager: {
                trackChatMessage: jest.fn().mockResolvedValue(undefined),
                dbManager: {
                    query: jest.fn().mockResolvedValue([{ token_value: 'true' }])
                }
            },
            aiManager: mockAiManager
        };

        chatMessageHandler = new ChatMessageHandler(
            mockViewerManager,
            mockCommandManager,
            mockEmoteManager,
            mockAiManager
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('handleChatMessage - Basic Flow', () => {
        it('should ignore messages without event', async () => {
            const payload = {};

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockViewerManager.trackInteraction).not.toHaveBeenCalled();
        });

        it('should ignore messages from bot itself', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'bot123',
                    chatter_user_name: 'BotAccount',
                    message: { text: 'test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockViewerManager.trackInteraction).not.toHaveBeenCalled();
        });

        it('should extract user context from badges', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    badges: [
                        { set_id: 'broadcaster' },
                        { set_id: 'moderator' },
                        { set_id: 'subscriber' },
                        { set_id: 'vip' }
                    ],
                    message: { text: 'hello' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                'hello',
                'message',
                expect.objectContaining({
                    isBroadcaster: true,
                    isMod: true,
                    isSubscriber: true,
                    isVip: true
                })
            );
        });

        it('should handle missing badges gracefully', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    badges: undefined,
                    message: { text: 'hello' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                'hello',
                'message',
                expect.objectContaining({
                    isBroadcaster: false,
                    isMod: false,
                    isSubscriber: false,
                    isVip: false
                })
            );
        });

        it('should ignore channel point redemption messages', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    channel_points_custom_reward_id: 'reward123',
                    message: { text: 'redeemed!' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).not.toHaveBeenCalled();
        });
    });

    describe('handleChatMessage - AI Text Response', () => {
        it('should trigger AI on matching trigger', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('whats up?');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai whats up?' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).toHaveBeenCalledWith(
                'whats up?',
                'user123',
                'stream456',
                expect.any(Object)
            );
        });

        it('should send AI response to chat', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');
            mockAiManager.handleTextRequest.mockResolvedValueOnce({
                success: true,
                response: 'AI says hello!'
            });

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                '@testuser AI says hello!'
            );
        });

        it('should send error message when AI fails', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');
            mockAiManager.handleTextRequest.mockResolvedValueOnce({
                success: false,
                message: 'Rate limited'
            });

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                '@testuser Rate limited'
            );
        });

        it('should not trigger AI when prompt is null', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce(null);

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).not.toHaveBeenCalled();
        });

        it('should track AI message as message type', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                '@almosthadai test',
                'message',
                expect.any(Object)
            );
        });

        it('should return after handling AI request', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai !command' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).not.toHaveBeenCalled();
        });
    });

    describe('handleChatMessage - Emote Response', () => {
        it('should respond to emote trigger', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValueOnce('PogChamp');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'KEKW' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                'PogChamp'
            );
        });

        it('should track emote trigger as message', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValueOnce('Response');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'emote' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                'emote',
                'message',
                expect.any(Object)
            );
        });

        it('should return after handling emote', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValueOnce('Response');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'emote !command' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).not.toHaveBeenCalled();
        });
    });

    describe('handleChatMessage - Command Handling', () => {
        it('should handle command starting with !', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '!test command' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).toHaveBeenCalledWith(
                mockBot,
                'testchannel',
                expect.objectContaining({
                    username: 'testuser',
                    userId: 'user123'
                }),
                '!test command'
            );
        });

        it('should track command as command type', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '!test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                '!test',
                'command',
                expect.any(Object)
            );
        });

        it('should pass correct context to command handler', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    badges: [
                        { set_id: 'broadcaster' }
                    ],
                    message: { text: '!test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).toHaveBeenCalledWith(
                mockBot,
                'testchannel',
                expect.objectContaining({
                    mod: false,
                    badges: {
                        broadcaster: true
                    }
                }),
                '!test'
            );
        });
    });

    describe('handleChatMessage - Regular Messages', () => {
        it('should track regular messages', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'hello chat!' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user123',
                'stream456',
                'hello chat!',
                'message',
                expect.any(Object)
            );
        });

        it('should not send any response for regular messages', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'just chatting' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).not.toHaveBeenCalled();
        });
    });

    describe('handleChatMessage - Error Handling', () => {
        it('should handle errors gracefully without crashing', async () => {
            mockBot.analyticsManager.trackChatMessage.mockRejectedValueOnce(
                new Error('DB Error')
            );

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'test' }
                }
            };

            await expect(
                chatMessageHandler.handleChatMessage(payload, mockBot)
            ).resolves.toBeUndefined();
        });

    });

    describe('Message Routing Priority', () => {
        it('should prioritize AI over emotes', async () => {
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');
            mockEmoteManager.getEmoteResponse.mockResolvedValueOnce('Emote');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai KEKW' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).toHaveBeenCalled();
            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                expect.stringContaining('AI response')
            );
        });

        it('should prioritize emotes over commands', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValueOnce('Emote response');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'emote !command' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                'Emote response'
            );
            expect(mockCommandManager.handleCommand).not.toHaveBeenCalled();
        });

        it('should check in order: AI -> Emotes -> Commands -> Regular', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: 'regular message' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.shouldTriggerText).toHaveBeenCalled();
            expect(mockEmoteManager.getEmoteResponse).toHaveBeenCalled();
            expect(mockCommandManager.handleCommand).not.toHaveBeenCalled();
        });
    });

    describe('AI enabled caching', () => {
        beforeEach(() => {
            chatMessageHandler = new ChatMessageHandler(
                mockViewerManager,
                mockCommandManager,
                mockEmoteManager,
                mockAiManager,
                mockRedisManager
            );
        });

        it('should get AI enabled from Redis cache', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce('true');
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(cacheManager.get).toHaveBeenCalledWith('cache:settings:aiEnabled');
            expect(mockBot.analyticsManager.dbManager.query).not.toHaveBeenCalled();
            expect(mockAiManager.handleTextRequest).toHaveBeenCalled();
        });

        it('should query DB on cache miss and cache result', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce(null);
            mockBot.analyticsManager.dbManager.query.mockResolvedValueOnce([{ token_value: 'true' }]);
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('SELECT token_value FROM tokens'),
                ['aiEnabled']
            );
            expect(cacheManager.set).toHaveBeenCalledWith(
                'cache:settings:aiEnabled',
                'true',
                60
            );
        });

        it('should respect AI disabled from cache', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce('false');
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).not.toHaveBeenCalled();
        });

        it('should work without Redis (fallback mode)', async () => {
            const disconnectedRedis = createMockRedisManager(false);
            chatMessageHandler = new ChatMessageHandler(
                mockViewerManager,
                mockCommandManager,
                mockEmoteManager,
                mockAiManager,
                disconnectedRedis
            );

            mockBot.analyticsManager.dbManager.query.mockResolvedValueOnce([{ token_value: 'true' }]);
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.dbManager.query).toHaveBeenCalled();
            expect(mockAiManager.handleTextRequest).toHaveBeenCalled();
        });

        it('should default to AI enabled on DB query error', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce(null);
            mockBot.analyticsManager.dbManager.query.mockRejectedValueOnce(new Error('DB error'));
            mockAiManager.shouldTriggerText.mockReturnValueOnce(true);
            mockAiManager.extractPrompt.mockReturnValueOnce('test');

            const payload = {
                event: {
                    chatter_user_id: 'user123',
                    chatter_user_name: 'testuser',
                    message: { text: '@almosthadai test' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).toHaveBeenCalled();
        });

    });
});
