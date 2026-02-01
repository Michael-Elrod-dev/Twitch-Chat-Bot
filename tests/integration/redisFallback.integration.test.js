// tests/integration/redisFallback.integration.test.js

const { createMockRedisManager, createDisconnectedRedisManager } = require('../__mocks__/mockRedisManager');
const { createMockDbManager } = require('../__mocks__/mockDbManager');

describe('Redis Fallback Integration', () => {
    describe('Command Manager Fallback', () => {
        let CommandManager;
        let commandManager;
        let mockDbManager;

        beforeEach(() => {
            jest.resetModules();

            jest.mock('../../src/config/config', () => ({
                commandCacheInterval: 60000,
                cache: {
                    commandsTTL: 500
                }
            }));

            CommandManager = require('../../src/commands/commandManager');
            mockDbManager = createMockDbManager();

            commandManager = new CommandManager({});
        });

        afterEach(() => {
            jest.clearAllMocks();
        });

        it('should use Redis cache when available', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();

            mockDbManager.query.mockResolvedValue([
                { command_name: '!test', response_text: 'Response', handler_name: null, user_level: 'everyone' }
            ]);

            await commandManager.init(mockDbManager, mockRedisManager);

            expect(cacheManager.del).toHaveBeenCalledWith('cache:commands');
            expect(cacheManager.hmset).toHaveBeenCalled();
        });

        it('should fall back to in-memory cache when Redis unavailable', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();

            mockDbManager.query.mockResolvedValue([
                { command_name: '!test', response_text: 'Response', handler_name: null, user_level: 'everyone' }
            ]);

            await commandManager.init(mockDbManager, disconnectedRedis);

            expect(commandManager.commandCache.has('!test')).toBe(true);
            expect(commandManager.getCacheManager()).toBeNull();
        });

        it('should fall back to DB when Redis cache is empty', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();

            mockDbManager.query.mockResolvedValue([
                { command_name: '!test', response_text: 'Response', handler_name: null, user_level: 'everyone' }
            ]);

            await commandManager.init(mockDbManager, mockRedisManager);

            cacheManager.hget.mockResolvedValue(null);
            cacheManager.hgetall.mockResolvedValue(null);

            mockDbManager.query.mockResolvedValue([
                { command_name: '!test', response_text: 'Updated', handler_name: null, user_level: 'everyone' }
            ]);

            const command = await commandManager.getCommand('!test');

            expect(command.response).toBe('Updated');
        });
    });

    describe('Rate Limiter Fallback', () => {
        let RateLimiter;
        let rateLimiter;
        let mockDbManager;

        beforeEach(() => {
            jest.resetModules();

            jest.mock('../../src/config/config', () => ({
                rateLimits: {
                    claude: {
                        streamLimits: {
                            broadcaster: 999999,
                            everyone: 5
                        }
                    }
                },
                errorMessages: {
                    ai: {
                        globalLimit: 'AI is temporarily busy.'
                    }
                }
            }));

            RateLimiter = require('../../src/ai/rateLimiter');
            mockDbManager = createMockDbManager();

            rateLimiter = new RateLimiter(mockDbManager);
        });

        afterEach(() => {
            jest.clearAllMocks();
        });

        it('should use Redis cache for rate limit check when available', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValue('3');

            rateLimiter = new RateLimiter(mockDbManager, mockRedisManager);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(cacheManager.get).toHaveBeenCalledWith('ratelimit:user123:claude:stream456');
            expect(result.allowed).toBe(true);
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should fall back to DB when Redis unavailable', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();
            mockDbManager.query.mockResolvedValue([{ stream_count: 2 }]);

            rateLimiter = new RateLimiter(mockDbManager, disconnectedRedis);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalled();
            expect(result.allowed).toBe(true);
        });

        it('should fall back to DB when Redis cache miss', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValue(null);
            mockDbManager.query.mockResolvedValue([{ stream_count: 2 }]);

            rateLimiter = new RateLimiter(mockDbManager, mockRedisManager);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalled();
            expect(cacheManager.set).toHaveBeenCalledWith('ratelimit:user123:claude:stream456', '2');
            expect(result.allowed).toBe(true);
        });

        it('should work with null redisManager', async () => {
            rateLimiter = new RateLimiter(mockDbManager, null);
            mockDbManager.query.mockResolvedValue([{ stream_count: 2 }]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalled();
            expect(result.allowed).toBe(true);
        });
    });

    describe('Analytics Manager Fallback', () => {
        let AnalyticsManager;
        let analyticsManager;
        let mockDbManager;

        beforeEach(() => {
            jest.resetModules();

            jest.mock('../../src/analytics/viewers/viewerTracker', () => {
                return jest.fn().mockImplementation(() => ({
                    trackInteraction: jest.fn().mockResolvedValue(true),
                    ensureUserExists: jest.fn().mockResolvedValue(true)
                }));
            });

            AnalyticsManager = require('../../src/analytics/analyticsManager');
            mockDbManager = createMockDbManager({ defaultQueryResult: { affectedRows: 1 } });

            analyticsManager = new AnalyticsManager();
        });

        afterEach(() => {
            jest.clearAllMocks();
        });

        it('should start queue consumer when Redis available', async () => {
            const mockRedisManager = createMockRedisManager(true, { withQueueManager: true });

            await analyticsManager.init(mockDbManager, mockRedisManager);

            const queueManager = mockRedisManager.getQueueManager();
            expect(queueManager.startConsumer).toHaveBeenCalled();
        });

        it('should work without queue consumer when Redis unavailable', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();

            await analyticsManager.init(mockDbManager, disconnectedRedis);

            expect(analyticsManager.redisManager).toBe(disconnectedRedis);
        });

        it('should track messages directly to DB when Redis unavailable', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();

            await analyticsManager.init(mockDbManager, disconnectedRedis);

            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Hello!',
                'message',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalled();
        });
    });

    describe('Chat Message Handler AI Enabled Check', () => {
        let ChatMessageHandler;
        let chatMessageHandler;
        let mockDbManager;

        beforeEach(() => {
            jest.resetModules();

            jest.mock('../../src/config/config', () => ({
                cache: {
                    aiEnabledTTL: 300
                }
            }));

            ChatMessageHandler = require('../../src/messages/chatMessageHandler');
            mockDbManager = createMockDbManager();
        });

        afterEach(() => {
            jest.clearAllMocks();
        });

        it('should use Redis cache for AI enabled check', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValue('true');

            chatMessageHandler = new ChatMessageHandler(
                {},
                {},
                {},
                {},
                mockRedisManager
            );

            const mockBot = {
                analyticsManager: { dbManager: mockDbManager }
            };

            const result = await chatMessageHandler.isAIEnabled(mockBot);

            expect(result).toBe(true);
            expect(cacheManager.get).toHaveBeenCalledWith('cache:settings:aiEnabled');
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should fall back to DB when Redis cache miss', async () => {
            const mockRedisManager = createMockRedisManager(true);
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValue(null);
            mockDbManager.query.mockResolvedValue([{ token_value: 'false' }]);

            chatMessageHandler = new ChatMessageHandler(
                {},
                {},
                {},
                {},
                mockRedisManager
            );

            const mockBot = {
                analyticsManager: { dbManager: mockDbManager }
            };

            const result = await chatMessageHandler.isAIEnabled(mockBot);

            expect(result).toBe(false);
            expect(mockDbManager.query).toHaveBeenCalled();
            expect(cacheManager.set).toHaveBeenCalled();
        });

        it('should use DB directly when Redis unavailable', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();
            mockDbManager.query.mockResolvedValue([{ token_value: 'true' }]);

            chatMessageHandler = new ChatMessageHandler(
                {},
                {},
                {},
                {},
                disconnectedRedis
            );

            const mockBot = {
                analyticsManager: { dbManager: mockDbManager }
            };

            const result = await chatMessageHandler.isAIEnabled(mockBot);

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalled();
        });

        it('should default to true when DB has no record', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();
            mockDbManager.query.mockResolvedValue([]);

            chatMessageHandler = new ChatMessageHandler(
                {},
                {},
                {},
                {},
                disconnectedRedis
            );

            const mockBot = {
                analyticsManager: { dbManager: mockDbManager }
            };

            const result = await chatMessageHandler.isAIEnabled(mockBot);

            expect(result).toBe(true);
        });

        it('should default to true on error', async () => {
            const disconnectedRedis = createDisconnectedRedisManager();
            mockDbManager.query.mockRejectedValue(new Error('DB Error'));

            chatMessageHandler = new ChatMessageHandler(
                {},
                {},
                {},
                {},
                disconnectedRedis
            );

            const mockBot = {
                analyticsManager: { dbManager: mockDbManager }
            };

            const result = await chatMessageHandler.isAIEnabled(mockBot);

            expect(result).toBe(true);
        });
    });
});
