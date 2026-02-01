// tests/redis/redisManager.test.js

const RedisManager = require('../../src/redis/redisManager');

jest.mock('ioredis');
jest.mock('../../src/config/config', () => ({
    redis: {
        host: 'localhost',
        port: 6379,
        password: 'test-password',
        db: 0,
        keyPrefix: 'twitchbot:'
    }
}));
jest.mock('../../src/redis/cacheManager');
jest.mock('../../src/redis/queueManager');

const Redis = require('ioredis');
const CacheManager = require('../../src/redis/cacheManager');
const QueueManager = require('../../src/redis/queueManager');

describe('RedisManager', () => {
    let redisManager;
    let mockClient;
    let mockDbManager;
    let mockCacheManager;
    let mockQueueManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockClient = {
            connect: jest.fn().mockResolvedValue(undefined),
            ping: jest.fn().mockResolvedValue('PONG'),
            quit: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn(),
            on: jest.fn()
        };

        Redis.mockImplementation(() => mockClient);

        mockDbManager = {
            query: jest.fn()
        };

        mockCacheManager = {};
        mockQueueManager = {
            stopConsumer: jest.fn().mockResolvedValue(undefined),
            drainQueues: jest.fn().mockResolvedValue(undefined)
        };

        CacheManager.mockImplementation(() => mockCacheManager);
        QueueManager.mockImplementation(() => mockQueueManager);

        redisManager = new RedisManager();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with null/default values', () => {
            expect(redisManager.client).toBeNull();
            expect(redisManager.isConnected).toBe(false);
            expect(redisManager.healthCheckInterval).toBeNull();
            expect(redisManager.cacheManager).toBeNull();
            expect(redisManager.queueManager).toBeNull();
            expect(redisManager.reconnectAttempts).toBe(0);
            expect(redisManager.maxReconnectAttempts).toBe(10);
        });
    });

    describe('init', () => {
        it('should connect successfully and create child managers', async () => {
            const result = await redisManager.init(mockDbManager);

            expect(result).toBe(true);
            expect(Redis).toHaveBeenCalledWith(expect.objectContaining({
                host: 'localhost',
                port: 6379,
                password: 'test-password',
                db: 0,
                keyPrefix: 'twitchbot:',
                lazyConnect: true
            }));
            expect(mockClient.connect).toHaveBeenCalled();
            expect(mockClient.ping).toHaveBeenCalled();
            expect(redisManager.isConnected).toBe(true);
            expect(CacheManager).toHaveBeenCalledWith(redisManager);
            expect(QueueManager).toHaveBeenCalledWith(redisManager, mockDbManager);
        });

        it('should return false and set fallback mode when Redis unavailable', async () => {
            mockClient.connect.mockRejectedValue(new Error('Connection refused'));

            const result = await redisManager.init(mockDbManager);

            expect(result).toBe(false);
            expect(redisManager.isConnected).toBe(false);
        });

        it('should return false when ping fails', async () => {
            mockClient.ping.mockRejectedValue(new Error('Ping failed'));

            const result = await redisManager.init(mockDbManager);

            expect(result).toBe(false);
        });

        it('should start health check after successful connection', async () => {
            await redisManager.init(mockDbManager);

            expect(redisManager.healthCheckInterval).not.toBeNull();
        });
    });

    describe('setupEventHandlers', () => {
        beforeEach(async () => {
            await redisManager.init(mockDbManager);
        });

        it('should register connect event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
        });

        it('should register ready event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
        });

        it('should register error event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('should register close event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('close', expect.any(Function));
        });

        it('should register reconnecting event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('reconnecting', expect.any(Function));
        });

        it('should register end event handler', () => {
            expect(mockClient.on).toHaveBeenCalledWith('end', expect.any(Function));
        });

        it('should set isConnected to true on ready event', () => {
            const readyHandler = mockClient.on.mock.calls.find(call => call[0] === 'ready')[1];
            redisManager.isConnected = false;
            redisManager.reconnectAttempts = 5;

            readyHandler();

            expect(redisManager.isConnected).toBe(true);
            expect(redisManager.reconnectAttempts).toBe(0);
        });

        it('should set isConnected to false on close event', () => {
            const closeHandler = mockClient.on.mock.calls.find(call => call[0] === 'close')[1];
            redisManager.isConnected = true;

            closeHandler();

            expect(redisManager.isConnected).toBe(false);
        });

        it('should increment reconnectAttempts on reconnecting event', () => {
            const reconnectingHandler = mockClient.on.mock.calls.find(call => call[0] === 'reconnecting')[1];
            redisManager.reconnectAttempts = 2;

            reconnectingHandler();

            expect(redisManager.reconnectAttempts).toBe(3);
        });

    });

    describe('ping', () => {
        beforeEach(async () => {
            await redisManager.init(mockDbManager);
        });

        it('should return true when ping returns PONG', async () => {
            mockClient.ping.mockResolvedValue('PONG');

            const result = await redisManager.ping();

            expect(result).toBe(true);
        });

        it('should throw error when client not initialized', async () => {
            redisManager.client = null;

            await expect(redisManager.ping()).rejects.toThrow('Redis client not initialized');
        });

        it('should throw error when ping response is not PONG', async () => {
            mockClient.ping.mockResolvedValue('UNEXPECTED');

            await expect(redisManager.ping()).rejects.toThrow('Unexpected ping response: UNEXPECTED');
        });
    });

    describe('connected', () => {
        it('should return true when connected and client exists', async () => {
            await redisManager.init(mockDbManager);

            expect(redisManager.connected()).toBe(true);
        });

        it('should return false when not connected', () => {
            redisManager.isConnected = false;
            redisManager.client = mockClient;

            expect(redisManager.connected()).toBe(false);
        });

        it('should return false when client is null', () => {
            redisManager.isConnected = true;
            redisManager.client = null;

            expect(redisManager.connected()).toBe(false);
        });
    });

    describe('getClient', () => {
        it('should return client after init', async () => {
            await redisManager.init(mockDbManager);

            expect(redisManager.getClient()).toBe(mockClient);
        });

        it('should return null before init', () => {
            expect(redisManager.getClient()).toBeNull();
        });
    });

    describe('getCacheManager', () => {
        it('should return cacheManager after init', async () => {
            await redisManager.init(mockDbManager);

            expect(redisManager.getCacheManager()).toBe(mockCacheManager);
        });

        it('should return null before init', () => {
            expect(redisManager.getCacheManager()).toBeNull();
        });
    });

    describe('getQueueManager', () => {
        it('should return queueManager after init', async () => {
            await redisManager.init(mockDbManager);

            expect(redisManager.getQueueManager()).toBe(mockQueueManager);
        });

        it('should return null before init', () => {
            expect(redisManager.getQueueManager()).toBeNull();
        });
    });

    describe('startHealthCheck', () => {
        beforeEach(async () => {
            await redisManager.init(mockDbManager);
        });

        it('should run health check on interval', async () => {
            jest.clearAllMocks();

            await jest.advanceTimersByTimeAsync(30000);

            expect(mockClient.ping).toHaveBeenCalled();
        });

        it('should set isConnected to true if ping succeeds after failure', async () => {
            redisManager.isConnected = false;
            mockClient.ping.mockResolvedValue('PONG');

            await jest.advanceTimersByTimeAsync(30000);

            expect(redisManager.isConnected).toBe(true);
        });

        it('should set isConnected to false if ping fails', async () => {
            mockClient.ping.mockRejectedValue(new Error('Ping failed'));

            await jest.advanceTimersByTimeAsync(30000);

            expect(redisManager.isConnected).toBe(false);
        });

        it('should clear existing interval on restart', async () => {
            const firstInterval = redisManager.healthCheckInterval;

            redisManager.startHealthCheck();

            expect(redisManager.healthCheckInterval).not.toBe(firstInterval);
        });
    });

    describe('close', () => {
        beforeEach(async () => {
            await redisManager.init(mockDbManager);
        });

        it('should stop queue consumer and close client', async () => {
            await redisManager.close();

            expect(mockQueueManager.stopConsumer).toHaveBeenCalled();
            expect(mockClient.quit).toHaveBeenCalled();
            expect(redisManager.isConnected).toBe(false);
            expect(redisManager.client).toBeNull();
        });

        it('should clear health check interval', async () => {
            expect(redisManager.healthCheckInterval).not.toBeNull();

            await redisManager.close();

            expect(redisManager.healthCheckInterval).toBeNull();
        });

        it('should disconnect if quit fails', async () => {
            mockClient.quit.mockRejectedValue(new Error('Quit failed'));

            await redisManager.close();

            expect(mockClient.disconnect).toHaveBeenCalled();
        });

        it('should handle stopConsumer error gracefully', async () => {
            mockQueueManager.stopConsumer.mockRejectedValue(new Error('Stop failed'));

            await redisManager.close();

            expect(mockClient.quit).toHaveBeenCalled();
        });

        it('should handle null queueManager', async () => {
            redisManager.queueManager = null;

            await expect(redisManager.close()).resolves.not.toThrow();
        });

        it('should handle null client', async () => {
            redisManager.client = null;

            await expect(redisManager.close()).resolves.not.toThrow();
        });
    });

    describe('drainQueues', () => {
        beforeEach(async () => {
            await redisManager.init(mockDbManager);
        });

        it('should delegate to queueManager', async () => {
            await redisManager.drainQueues(5000);

            expect(mockQueueManager.drainQueues).toHaveBeenCalledWith(5000);
        });

        it('should handle null queueManager', async () => {
            redisManager.queueManager = null;

            await expect(redisManager.drainQueues(5000)).resolves.not.toThrow();
        });
    });

    describe('Retry strategy', () => {
        it('should pass retry strategy to ioredis', async () => {
            await redisManager.init(mockDbManager);

            const constructorCall = Redis.mock.calls[0][0];
            expect(constructorCall.retryStrategy).toBeDefined();
        });

        it('should return delay for reconnection attempts under max', async () => {
            await redisManager.init(mockDbManager);

            const retryStrategy = Redis.mock.calls[0][0].retryStrategy;
            const delay = retryStrategy(5);

            expect(delay).toBe(2500);
        });

        it('should cap delay at 5000ms', async () => {
            await redisManager.init(mockDbManager);

            const retryStrategy = Redis.mock.calls[0][0].retryStrategy;
            const delay = retryStrategy(10);

            expect(delay).toBe(5000);
        });

        it('should return null after max reconnection attempts', async () => {
            await redisManager.init(mockDbManager);

            const retryStrategy = Redis.mock.calls[0][0].retryStrategy;
            const result = retryStrategy(11);

            expect(result).toBeNull();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete lifecycle', async () => {
            const initResult = await redisManager.init(mockDbManager);
            expect(initResult).toBe(true);
            expect(redisManager.connected()).toBe(true);

            await jest.advanceTimersByTimeAsync(30000);
            expect(mockClient.ping).toHaveBeenCalled();

            await redisManager.close();
            expect(redisManager.connected()).toBe(false);
        });

        it('should handle fallback mode gracefully', async () => {
            mockClient.connect.mockRejectedValue(new Error('Redis unavailable'));

            const initResult = await redisManager.init(mockDbManager);
            expect(initResult).toBe(false);

            expect(redisManager.connected()).toBe(false);

            expect(redisManager.getCacheManager()).toBeNull();
            expect(redisManager.getQueueManager()).toBeNull();
        });
    });
});
