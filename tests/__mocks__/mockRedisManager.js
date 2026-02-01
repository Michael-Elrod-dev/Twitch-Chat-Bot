// tests/__mocks__/mockRedisManager.js

/**
 * Creates a mock Redis manager for testing
 * @param {boolean} connected - Whether Redis should appear connected
 * @param {Object} options - Additional configuration options
 * @param {boolean} options.withQueueManager - Include queue manager mock
 * @param {Object} options.cacheOverrides - Override cache manager methods
 * @param {Object} options.queueOverrides - Override queue manager methods
 * @returns {Object} Mock Redis manager
 */
const createMockRedisManager = (connected = true, options = {}) => {
    const { withQueueManager = false, cacheOverrides = {}, queueOverrides = {} } = options;

    const mockCacheManager = connected ? {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(true),
        del: jest.fn().mockResolvedValue(true),
        hget: jest.fn().mockResolvedValue(null),
        hset: jest.fn().mockResolvedValue(true),
        hdel: jest.fn().mockResolvedValue(true),
        hgetall: jest.fn().mockResolvedValue(null),
        hmset: jest.fn().mockResolvedValue(true),
        expire: jest.fn().mockResolvedValue(true),
        incr: jest.fn().mockResolvedValue(1),
        ...cacheOverrides
    } : null;

    const mockQueueManager = (connected && withQueueManager) ? {
        startConsumer: jest.fn().mockResolvedValue(undefined),
        stopConsumer: jest.fn().mockResolvedValue(undefined),
        push: jest.fn().mockResolvedValue(true),
        pop: jest.fn().mockResolvedValue([]),
        ...queueOverrides
    } : null;

    return {
        connected: jest.fn().mockReturnValue(connected),
        getCacheManager: jest.fn().mockReturnValue(mockCacheManager),
        getQueueManager: jest.fn().mockReturnValue(mockQueueManager)
    };
};

/**
 * Creates a mock Redis manager with queue manager support
 * @param {boolean} connected - Whether Redis should appear connected
 * @param {Object} options - Additional configuration options
 * @returns {Object} Mock Redis manager with queue manager
 */
const createMockRedisManagerWithQueue = (connected = true, options = {}) => {
    return createMockRedisManager(connected, { ...options, withQueueManager: true });
};

/**
 * Creates a disconnected mock Redis manager
 * @returns {Object} Disconnected mock Redis manager
 */
const createDisconnectedRedisManager = () => {
    return createMockRedisManager(false);
};

module.exports = {
    createMockRedisManager,
    createMockRedisManagerWithQueue,
    createDisconnectedRedisManager
};
