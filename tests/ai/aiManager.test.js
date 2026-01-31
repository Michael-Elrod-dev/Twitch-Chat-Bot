// tests/ai/aiManager.test.js

const AIManager = require('../../src/ai/aiManager');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    aiTriggers: {
        text: ['@almosthadai', 'almosthadai']
    },
    errorMessages: {
        ai: {
            unavailable: 'Sorry, I\'m having trouble responding right now.'
        }
    },
    aiSettings: {
        claude: {
            chatHistoryLimits: {
                regularChat: 50,
                advice: 0,
                roast: 0
            }
        }
    }
}));

jest.mock('../../src/ai/rateLimiter');
jest.mock('../../src/ai/models/claudeModel');
jest.mock('../../src/ai/contextBuilder');
jest.mock('../../src/ai/promptBuilder');

const RateLimiter = require('../../src/ai/rateLimiter');
const ClaudeModel = require('../../src/ai/models/claudeModel');
const ContextBuilder = require('../../src/ai/contextBuilder');
const PromptBuilder = require('../../src/ai/promptBuilder');

const createMockRedisManager = (connected = true) => ({
    connected: jest.fn().mockReturnValue(connected),
    getCacheManager: jest.fn().mockReturnValue(connected ? {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(true),
        incr: jest.fn().mockResolvedValue(1)
    } : null),
    getQueueManager: jest.fn().mockReturnValue(null)
});

describe('AIManager', () => {
    let aiManager;
    let mockDbManager;
    let mockRedisManager;
    let mockRateLimiter;
    let mockClaudeModel;
    let mockContextBuilder;
    let mockPromptBuilder;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        mockRedisManager = createMockRedisManager(true);

        mockRateLimiter = {
            checkRateLimit: jest.fn(),
            updateUsage: jest.fn(),
            getUserStats: jest.fn(),
            getUserLimits: jest.fn()
        };

        mockClaudeModel = {
            getTextResponse: jest.fn()
        };

        mockContextBuilder = {
            getAllContext: jest.fn().mockResolvedValue({
                streamContext: null,
                chatHistory: [],
                userRoles: {
                    broadcaster: 'Unknown',
                    mods: []
                }
            })
        };

        mockPromptBuilder = {
            buildUserMessage: jest.fn((prompt) => prompt)
        };

        RateLimiter.mockImplementation(() => mockRateLimiter);
        ClaudeModel.mockImplementation(() => mockClaudeModel);
        ContextBuilder.mockImplementation(() => mockContextBuilder);
        PromptBuilder.mockImplementation(() => mockPromptBuilder);

        aiManager = new AIManager();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('init', () => {
        it('should initialize with database and API key', async () => {
            await aiManager.init(mockDbManager, 'test-api-key');

            expect(aiManager.dbManager).toBe(mockDbManager);
            expect(aiManager.claudeModel).toBeDefined();
            expect(aiManager.rateLimiter).toBeDefined();
        });

        it('should create ClaudeModel with API key', async () => {
            await aiManager.init(mockDbManager, 'my-secret-key');

            expect(ClaudeModel).toHaveBeenCalledWith('my-secret-key');
        });

        it('should create RateLimiter with dbManager', async () => {
            await aiManager.init(mockDbManager, 'test-api-key');

            expect(RateLimiter).toHaveBeenCalledWith(mockDbManager, null);
        });

        it('should pass redisManager to RateLimiter', async () => {
            await aiManager.init(mockDbManager, 'test-api-key', mockRedisManager);

            expect(RateLimiter).toHaveBeenCalledWith(mockDbManager, mockRedisManager);
        });

        it('should store redisManager reference', async () => {
            await aiManager.init(mockDbManager, 'test-api-key', mockRedisManager);

            expect(aiManager.redisManager).toBe(mockRedisManager);
        });

        it('should log redisEnabled status', async () => {
            const logger = require('../../src/logger/logger');

            await aiManager.init(mockDbManager, 'test-api-key', mockRedisManager);

            expect(logger.info).toHaveBeenCalledWith(
                'AIManager',
                'AIManager initialized successfully',
                expect.objectContaining({
                    redisEnabled: true
                })
            );
        });

        it('should log redisEnabled as false when no Redis', async () => {
            const logger = require('../../src/logger/logger');

            await aiManager.init(mockDbManager, 'test-api-key', null);

            expect(logger.info).toHaveBeenCalledWith(
                'AIManager',
                'AIManager initialized successfully',
                expect.objectContaining({
                    redisEnabled: false
                })
            );
        });
    });

    describe('handleTextRequest', () => {
        beforeEach(async () => {
            await aiManager.init(mockDbManager, 'test-api-key');
        });

        it('should deny request when rate limited', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: false,
                message: 'Rate limit exceeded'
            });

            const result = await aiManager.handleTextRequest(
                'test prompt',
                'user123',
                'stream456',
                {}
            );

            expect(result).toEqual({
                success: false,
                message: 'Rate limit exceeded'
            });
            expect(mockClaudeModel.getTextResponse).not.toHaveBeenCalled();
        });

        it('should allow request when under rate limit', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('Hello from Claude!');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({
                streamCount: 3
            });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({
                streamLimit: 5
            });

            const result = await aiManager.handleTextRequest(
                'test prompt',
                'user123',
                'stream456',
                { isBroadcaster: false }
            );

            expect(result.success).toBe(true);
            expect(mockClaudeModel.getTextResponse).toHaveBeenCalledWith(
                'test prompt',
                { isBroadcaster: false },
                expect.any(String)
            );
        });

        it('should update usage after successful response', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('Response');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({
                streamCount: 1
            });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({
                streamLimit: 5
            });

            await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                {}
            );

            expect(mockRateLimiter.updateUsage).toHaveBeenCalledWith(
                'user123',
                'claude',
                'stream456'
            );
        });

        it('should include usage counter for non-broadcaster', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('Hello!');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({
                streamCount: 3
            });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({
                streamLimit: 5
            });

            const result = await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                { isBroadcaster: false }
            );

            expect(result.response).toBe('(3/5) Hello!');
        });

        it('should not include usage counter for broadcaster', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('Hello!');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({
                streamCount: 100
            });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({
                streamLimit: 999999
            });

            const result = await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                { isBroadcaster: true }
            );

            expect(result.response).toBe('Hello!');
        });

        it('should handle Claude API failure', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce(null);

            const result = await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                {}
            );

            expect(result).toEqual({
                success: false,
                message: 'Sorry, I\'m having trouble responding right now.'
            });
            expect(mockRateLimiter.updateUsage).not.toHaveBeenCalled();
        });

        it('should pass userContext to Claude', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('Response');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({ streamCount: 1 });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({ streamLimit: 5 });

            const userContext = {
                isMod: true,
                username: 'testmod'
            };

            await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                userContext
            );

            expect(mockClaudeModel.getTextResponse).toHaveBeenCalledWith(
                'test',
                userContext,
                expect.any(String)
            );
        });

        it('should check rate limit with correct parameters', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: false,
                message: 'Denied'
            });

            const userContext = { isMod: true };
            await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                userContext
            );

            expect(mockRateLimiter.checkRateLimit).toHaveBeenCalledWith(
                'user123',
                'claude',
                'stream456',
                userContext
            );
        });
    });

    describe('shouldTriggerText', () => {
        it('should trigger on @almosthadai mention', () => {
            const result = aiManager.shouldTriggerText('@almosthadai hello');

            expect(result).toBe(true);
        });

        it('should trigger on almosthadai without @', () => {
            const result = aiManager.shouldTriggerText('hey almosthadai');

            expect(result).toBe(true);
        });

        it('should be case insensitive', () => {
            expect(aiManager.shouldTriggerText('@ALMOSTHADAI')).toBe(true);
            expect(aiManager.shouldTriggerText('AlMoStHaDaI')).toBe(true);
        });

        it('should not trigger on unrelated messages', () => {
            const result = aiManager.shouldTriggerText('hello world');

            expect(result).toBe(false);
        });

        it('should trigger when mention is at start', () => {
            const result = aiManager.shouldTriggerText('@almosthadai test');

            expect(result).toBe(true);
        });

        it('should trigger when mention is in middle', () => {
            const result = aiManager.shouldTriggerText('hey @almosthadai test');

            expect(result).toBe(true);
        });

        it('should handle partial matches', () => {
            const result = aiManager.shouldTriggerText('myalmosthadaibot');

            expect(result).toBe(true); // includes() will match
        });
    });

    describe('extractPrompt', () => {
        it('should remove @almosthadai from text prompt', () => {
            const prompt = aiManager.extractPrompt('@almosthadai hello there', 'text');

            expect(prompt).toBe('hello there');
        });

        it('should remove almosthadai without @ from text prompt', () => {
            const prompt = aiManager.extractPrompt('hey almosthadai whats up', 'text');

            expect(prompt).toBe('hey  whats up');
        });

        it('should remove multiple mentions', () => {
            const prompt = aiManager.extractPrompt(
                '@almosthadai almosthadai test',
                'text'
            );

            expect(prompt).toBe('test');
        });

        it('should be case insensitive when removing mentions', () => {
            const prompt = aiManager.extractPrompt('@ALMOSTHADAI test', 'text');

            expect(prompt).toBe('test');
        });

        it('should return null for empty prompt after removal', () => {
            const prompt = aiManager.extractPrompt('@almosthadai', 'text');

            expect(prompt).toBeNull();
        });

        it('should trim whitespace', () => {
            const prompt = aiManager.extractPrompt('  @almosthadai   test  ', 'text');

            expect(prompt).toBe('test');
        });

        it('should handle prompt with only spaces after removal', () => {
            const prompt = aiManager.extractPrompt('@almosthadai   ', 'text');

            expect(prompt).toBeNull();
        });

        it('should preserve message content', () => {
            const prompt = aiManager.extractPrompt(
                '@almosthadai what is 2 + 2?',
                'text'
            );

            expect(prompt).toBe('what is 2 + 2?');
        });
    });

    describe('Integration Scenarios', () => {
        beforeEach(async () => {
            await aiManager.init(mockDbManager, 'test-api-key');
        });

        it('should handle complete successful flow', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('AI response here');
            mockRateLimiter.getUserStats.mockResolvedValueOnce({
                streamCount: 2
            });
            mockRateLimiter.getUserLimits.mockReturnValueOnce({
                streamLimit: 5
            });

            const result = await aiManager.handleTextRequest(
                'test prompt',
                'user123',
                'stream456',
                { isBroadcaster: false }
            );

            expect(result.success).toBe(true);
            expect(result.response).toBe('(2/5) AI response here');
            expect(mockRateLimiter.checkRateLimit).toHaveBeenCalled();
            expect(mockClaudeModel.getTextResponse).toHaveBeenCalled();
            expect(mockRateLimiter.updateUsage).toHaveBeenCalled();
        });

        it('should handle rate limit hit gracefully', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: false,
                message: 'You\'ve reached your limit (5/5)'
            });

            const result = await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('limit');
            expect(mockClaudeModel.getTextResponse).not.toHaveBeenCalled();
            expect(mockRateLimiter.updateUsage).not.toHaveBeenCalled();
        });

        it('should handle Claude API returning empty response', async () => {
            mockRateLimiter.checkRateLimit.mockResolvedValueOnce({
                allowed: true
            });
            mockClaudeModel.getTextResponse.mockResolvedValueOnce('');

            const result = await aiManager.handleTextRequest(
                'test',
                'user123',
                'stream456',
                {}
            );

            expect(result.success).toBe(false);
            expect(mockRateLimiter.updateUsage).not.toHaveBeenCalled();
        });
    });
});
