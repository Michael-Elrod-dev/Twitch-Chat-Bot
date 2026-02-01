// tests/integration/chatFlow.integration.test.js

const ChatMessageHandler = require('../../src/messages/chatMessageHandler');
const { createMockRedisManager } = require('../__mocks__/mockRedisManager');

jest.mock('../../src/config/config', () => ({
    cache: {
        aiEnabledTTL: 300
    }
}));

describe('Chat Flow Integration', () => {
    let chatMessageHandler;
    let mockViewerManager;
    let mockCommandManager;
    let mockEmoteManager;
    let mockAiManager;
    let mockBot;
    let mockRedisManager;

    beforeEach(() => {
        mockViewerManager = {
            ensureUserExists: jest.fn().mockResolvedValue(true),
            trackInteraction: jest.fn().mockResolvedValue(true)
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
            handleTextRequest: jest.fn()
        };

        mockRedisManager = createMockRedisManager(true);

        chatMessageHandler = new ChatMessageHandler(
            mockViewerManager,
            mockCommandManager,
            mockEmoteManager,
            mockAiManager,
            mockRedisManager
        );

        mockBot = {
            tokenManager: { tokens: { botId: 'bot-123' } },
            sendMessage: jest.fn().mockResolvedValue(undefined),
            channelName: 'testchannel',
            currentStreamId: 'stream-456',
            aiManager: mockAiManager,
            analyticsManager: {
                trackChatMessage: jest.fn().mockResolvedValue(undefined),
                dbManager: {
                    query: jest.fn().mockResolvedValue([{ token_value: 'true' }])
                }
            }
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Regular message flow', () => {
        it('should track regular chat message without triggering anything', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: 'Hello everyone!' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'TestUser',
                'user-123',
                'stream-456',
                'Hello everyone!',
                'message',
                expect.any(Object)
            );
            expect(mockBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from the bot itself', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'bot-123',
                    chatter_user_name: 'BotUser',
                    message: { text: 'Bot message' }
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).not.toHaveBeenCalled();
        });

        it('should ignore channel point redemptions', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: 'Redemption message' },
                    channel_points_custom_reward_id: 'reward-123'
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).not.toHaveBeenCalled();
        });
    });

    describe('Command flow', () => {
        it('should route messages starting with ! to command handler', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '!help' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).toHaveBeenCalledWith(
                mockBot,
                'testchannel',
                expect.objectContaining({
                    username: 'TestUser',
                    userId: 'user-123'
                }),
                '!help'
            );
            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'TestUser',
                'user-123',
                'stream-456',
                '!help',
                'command',
                expect.any(Object)
            );
        });

        it('should track command with proper type', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '!stats' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                '!stats',
                'command',
                expect.any(Object)
            );
        });
    });

    describe('Emote response flow', () => {
        it('should respond to emote triggers', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValue('Kappa response!');

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: 'kappa' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockEmoteManager.getEmoteResponse).toHaveBeenCalledWith('kappa');
            expect(mockBot.sendMessage).toHaveBeenCalledWith('testchannel', 'Kappa response!');
        });

        it('should track emote interaction', async () => {
            mockEmoteManager.getEmoteResponse.mockResolvedValue('Response!');

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: 'pogchamp' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalled();
        });
    });

    describe('AI request flow', () => {
        beforeEach(() => {
            mockAiManager.shouldTriggerText.mockReturnValue(true);
            mockAiManager.extractPrompt.mockReturnValue('What is the weather?');
        });

        it('should handle AI text request and send response', async () => {
            mockAiManager.handleTextRequest.mockResolvedValue({
                success: true,
                response: 'The weather is sunny!'
            });

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '@claude What is the weather?' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).toHaveBeenCalled();
            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                '@TestUser The weather is sunny!'
            );
        });

        it('should handle AI request failure', async () => {
            mockAiManager.handleTextRequest.mockResolvedValue({
                success: false,
                message: 'Rate limit exceeded'
            });

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '@claude test' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                '@TestUser Rate limit exceeded'
            );
        });

        it('should skip AI when disabled', async () => {
            mockBot.analyticsManager.dbManager.query.mockResolvedValue([
                { token_value: 'false' }
            ]);
            // Clear cache to force DB lookup
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValue(null);

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '@claude test' },
                    badges: []
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockAiManager.handleTextRequest).not.toHaveBeenCalled();
        });
    });

    describe('User context extraction', () => {
        it('should correctly identify broadcaster', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: '!test' },
                    badges: [{ set_id: 'broadcaster' }]
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).toHaveBeenCalledWith(
                mockBot,
                'testchannel',
                expect.objectContaining({
                    badges: { broadcaster: true }
                }),
                '!test'
            );
        });

        it('should correctly identify moderator', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'ModUser',
                    message: { text: '!modcommand' },
                    badges: [{ set_id: 'moderator' }]
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockCommandManager.handleCommand).toHaveBeenCalledWith(
                mockBot,
                'testchannel',
                expect.objectContaining({
                    mod: true
                }),
                '!modcommand'
            );
        });

        it('should correctly identify subscriber', async () => {
            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'SubUser',
                    message: { text: 'Hello!' },
                    badges: [{ set_id: 'subscriber' }]
                }
            };

            await chatMessageHandler.handleChatMessage(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'SubUser',
                'user-123',
                'stream-456',
                'Hello!',
                'message',
                expect.objectContaining({
                    isSubscriber: true
                })
            );
        });
    });

    describe('Error handling', () => {
        it('should handle errors gracefully without throwing', async () => {
            mockEmoteManager.getEmoteResponse.mockRejectedValue(new Error('Service error'));

            const payload = {
                event: {
                    chatter_user_id: 'user-123',
                    chatter_user_name: 'TestUser',
                    message: { text: 'test' },
                    badges: []
                }
            };

            await expect(
                chatMessageHandler.handleChatMessage(payload, mockBot)
            ).resolves.not.toThrow();
        });

        it('should handle missing event gracefully', async () => {
            const payload = {};

            await expect(
                chatMessageHandler.handleChatMessage(payload, mockBot)
            ).resolves.not.toThrow();
        });
    });
});
