// tests/ai/rateLimiter.test.js

const RateLimiter = require('../../src/ai/rateLimiter');

jest.mock('../../src/config/config', () => ({
    rateLimits: {
        claude: {
            streamLimits: {
                broadcaster: 999999,
                mod: 50,
                subscriber: 50,
                vip: 50,
                everyone: 5
            }
        }
    },
    errorMessages: {
        ai: {
            globalLimit: 'AI is temporarily busy. Please try again in a moment.'
        }
    }
}));

const { createMockRedisManager } = require('../__mocks__/mockRedisManager');

describe('RateLimiter', () => {
    let rateLimiter;
    let mockDbManager;
    let mockRedisManager;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        mockRedisManager = createMockRedisManager(true);

        rateLimiter = new RateLimiter(mockDbManager);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getUserLimits', () => {
        it('should return broadcaster limits for broadcaster', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isBroadcaster: true
            });

            expect(limits).toEqual({
                streamLimit: 999999
            });
        });

        it('should return mod limits for moderators', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isMod: true,
                isBroadcaster: false
            });

            expect(limits).toEqual({
                streamLimit: 50
            });
        });

        it('should return subscriber limits for subscribers', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isSubscriber: true,
                isVip: false,
                isMod: false,
                isBroadcaster: false
            });

            expect(limits).toEqual({
                streamLimit: 50
            });
        });

        it('should return vip limits for vips', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isVip: true,
                isSubscriber: false,
                isMod: false,
                isBroadcaster: false
            });

            expect(limits).toEqual({
                streamLimit: 50
            });
        });

        it('should return everyone limits for regular viewers', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isBroadcaster: false,
                isMod: false,
                isSubscriber: false,
                isVip: false
            });

            expect(limits).toEqual({
                streamLimit: 5
            });
        });

        it('should prioritize broadcaster over mod', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isBroadcaster: true,
                isMod: true
            });

            expect(limits.streamLimit).toBe(999999);
        });

        it('should prioritize mod over subscriber', () => {
            const limits = rateLimiter.getUserLimits('claude', {
                isMod: true,
                isSubscriber: true,
                isBroadcaster: false
            });

            expect(limits.streamLimit).toBe(50);
        });

        it('should throw error for unknown service', () => {
            expect(() => {
                rateLimiter.getUserLimits('unknown_service', {});
            }).toThrow('No rate limit config found for service: unknown_service');
        });

        it('should handle empty userContext', () => {
            const limits = rateLimiter.getUserLimits('claude', {});

            expect(limits.streamLimit).toBe(5); // everyone
        });
    });

    describe('checkRateLimit', () => {
        it('should allow request when under limit', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 3 }
            ]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                { isBroadcaster: false, isMod: false, isSubscriber: false }
            );

            expect(result.allowed).toBe(true);
            expect(result.reason).toBeNull();
        });

        it('should deny request when at limit', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 5 }
            ]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                { isBroadcaster: false, isMod: false, isSubscriber: false }
            );

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('stream_limit');
            expect(result.message).toContain('You\'ve reached your CLAUDE limit');
            expect(result.message).toContain('5/5');
        });

        it('should deny request when over limit', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 10 }
            ]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                { isBroadcaster: false, isMod: false, isSubscriber: false }
            );

            expect(result.allowed).toBe(false);
        });

        it('should allow request for new user with no usage', async () => {
            mockDbManager.query.mockResolvedValueOnce([]); // No rows = count 0

            const result = await rateLimiter.checkRateLimit(
                'newuser',
                'claude',
                'stream456',
                {}
            );

            expect(result.allowed).toBe(true);
        });

        it('should always allow broadcaster requests', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 500000 }
            ]);

            const result = await rateLimiter.checkRateLimit(
                'broadcaster',
                'claude',
                'stream456',
                { isBroadcaster: true }
            );

            expect(result.allowed).toBe(true);
        });

        it('should query database with correct parameters', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['user123', 'claude', 'stream456']
            );
        });

        it('should handle database errors gracefully', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Connection Lost'));

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('error');
            expect(result.message).toBe('AI is temporarily busy. Please try again in a moment.');
        });

        it('should include usage stats in denial message', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 50 }
            ]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                { isMod: true }
            );

            expect(result.streamCount).toBe(50);
            expect(result.streamLimit).toBe(50);
        });
    });

    describe('updateUsage', () => {
        it('should insert new usage record for first use', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.updateUsage('user123', 'claude', 'stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO api_usage'),
                ['user123', 'claude', 'stream456']
            );
        });

        it('should increment count on duplicate key', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.updateUsage('user123', 'claude', 'stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('ON DUPLICATE KEY UPDATE'),
                expect.anything()
            );
        });

        it('should handle database errors without throwing', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                rateLimiter.updateUsage('user123', 'claude', 'stream456')
            ).resolves.toBeUndefined();
        });

        it('should use correct SQL structure', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.updateUsage('user123', 'claude', 'stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['user123', 'claude', 'stream456']
            );
        });
    });

    describe('getUserStats', () => {
        it('should return current usage for user', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { stream_count: 15 }
            ]);

            const stats = await rateLimiter.getUserStats('user123', 'claude', 'stream456');

            expect(stats).toEqual({
                streamCount: 15
            });
        });

        it('should return 0 count for new user', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const stats = await rateLimiter.getUserStats('newuser', 'claude', 'stream456');

            expect(stats).toEqual({
                streamCount: 0
            });
        });

        it('should handle database errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const stats = await rateLimiter.getUserStats('user123', 'claude', 'stream456');

            expect(stats).toEqual({
                streamCount: 0
            });
        });

        it('should query correct table and columns', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.getUserStats('user123', 'claude', 'stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['user123', 'claude', 'stream456']
            );
        });
    });

    describe('Integration Scenarios', () => {
        it('should handle full request lifecycle for regular user', async () => {
            const userId = 'user123';
            const service = 'claude';
            const streamId = 'stream456';
            const userContext = {};

            mockDbManager.query.mockResolvedValueOnce([]);
            let result = await rateLimiter.checkRateLimit(userId, service, streamId, userContext);
            expect(result.allowed).toBe(true);

            mockDbManager.query.mockResolvedValueOnce([]);
            await rateLimiter.updateUsage(userId, service, streamId);

            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 4 }]);
            result = await rateLimiter.checkRateLimit(userId, service, streamId, userContext);
            expect(result.allowed).toBe(true);

            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 5 }]);
            result = await rateLimiter.checkRateLimit(userId, service, streamId, userContext);
            expect(result.allowed).toBe(false);
        });

        it('should track separate limits per stream', async () => {
            const userId = 'user123';
            const service = 'claude';

            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 5 }]);
            let result = await rateLimiter.checkRateLimit(userId, service, 'stream1', {});
            expect(result.allowed).toBe(false);

            mockDbManager.query.mockResolvedValueOnce([]);
            result = await rateLimiter.checkRateLimit(userId, service, 'stream2', {});
            expect(result.allowed).toBe(true);
        });

        it('should respect user role changes mid-stream', async () => {
            const userId = 'user123';
            const service = 'claude';
            const streamId = 'stream456';

            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 4 }]);
            let result = await rateLimiter.checkRateLimit(userId, service, streamId, {});
            expect(result.allowed).toBe(true);

            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 4 }]);
            result = await rateLimiter.checkRateLimit(userId, service, streamId, { isMod: true });
            expect(result.allowed).toBe(true);
        });
    });

    describe('Redis caching', () => {
        beforeEach(() => {
            rateLimiter = new RateLimiter(mockDbManager, mockRedisManager);
        });

        it('should get rate limit from Redis cache', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce('3');

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                { isBroadcaster: false }
            );

            expect(cacheManager.get).toHaveBeenCalledWith('ratelimit:user123:claude:stream456');
            expect(result.allowed).toBe(true);
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should use correct cache key format', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce(null);
            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 2 }]);

            await rateLimiter.checkRateLimit('user123', 'claude', 'stream456', {});

            expect(cacheManager.get).toHaveBeenCalledWith('ratelimit:user123:claude:stream456');
            expect(cacheManager.set).toHaveBeenCalledWith('ratelimit:user123:claude:stream456', '2');
        });

        it('should fall back to DB when cache miss', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            cacheManager.get.mockResolvedValueOnce(null);
            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 2 }]);

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

        it('should increment Redis counter on updateUsage', async () => {
            const cacheManager = mockRedisManager.getCacheManager();
            mockDbManager.query.mockResolvedValueOnce([]);

            await rateLimiter.updateUsage('user123', 'claude', 'stream456');

            expect(cacheManager.incr).toHaveBeenCalledWith('ratelimit:user123:claude:stream456');
        });

        it('should work without Redis (fallback mode)', async () => {
            const disconnectedRedis = createMockRedisManager(false);
            rateLimiter = new RateLimiter(mockDbManager, disconnectedRedis);
            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 2 }]);

            const result = await rateLimiter.checkRateLimit(
                'user123',
                'claude',
                'stream456',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalled();
            expect(result.allowed).toBe(true);
        });

        it('should work with null redisManager', async () => {
            rateLimiter = new RateLimiter(mockDbManager, null);
            mockDbManager.query.mockResolvedValueOnce([{ stream_count: 2 }]);

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
});
