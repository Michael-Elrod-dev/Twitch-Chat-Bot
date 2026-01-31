// tests/redis/cacheManager.test.js

const CacheManager = require('../../src/redis/cacheManager');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../../src/logger/logger');

describe('CacheManager', () => {
    let cacheManager;
    let mockRedisManager;
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        mockClient = {
            get: jest.fn(),
            set: jest.fn(),
            setex: jest.fn(),
            del: jest.fn(),
            hget: jest.fn(),
            hset: jest.fn(),
            hdel: jest.fn(),
            hgetall: jest.fn(),
            hmset: jest.fn(),
            expire: jest.fn(),
            incr: jest.fn()
        };

        mockRedisManager = {
            connected: jest.fn().mockReturnValue(true),
            getClient: jest.fn().mockReturnValue(mockClient)
        };

        cacheManager = new CacheManager(mockRedisManager);
    });

    describe('constructor', () => {
        it('should initialize with redisManager reference', () => {
            expect(cacheManager.redisManager).toBe(mockRedisManager);
        });
    });

    describe('isAvailable', () => {
        it('should return true when Redis is connected', () => {
            mockRedisManager.connected.mockReturnValue(true);

            expect(cacheManager.isAvailable()).toBe(true);
        });

        it('should return false when Redis is not connected', () => {
            mockRedisManager.connected.mockReturnValue(false);

            expect(cacheManager.isAvailable()).toBe(false);
        });

        it('should return false when redisManager is null', () => {
            cacheManager = new CacheManager(null);

            expect(cacheManager.isAvailable()).toBeFalsy();
        });
    });

    describe('getClient', () => {
        it('should return client when available', () => {
            expect(cacheManager.getClient()).toBe(mockClient);
        });

        it('should return null when Redis is not available', () => {
            mockRedisManager.connected.mockReturnValue(false);

            expect(cacheManager.getClient()).toBeNull();
        });
    });

    describe('get', () => {
        it('should return parsed JSON value from Redis', async () => {
            mockClient.get.mockResolvedValue('{"name":"test","value":123}');

            const result = await cacheManager.get('test-key');

            expect(result).toEqual({ name: 'test', value: 123 });
            expect(mockClient.get).toHaveBeenCalledWith('test-key');
        });

        it('should return string value when not valid JSON', async () => {
            mockClient.get.mockResolvedValue('plain string value');

            const result = await cacheManager.get('test-key');

            expect(result).toBe('plain string value');
        });

        it('should return null when key does not exist', async () => {
            mockClient.get.mockResolvedValue(null);

            const result = await cacheManager.get('nonexistent');

            expect(result).toBeNull();
        });

        it('should return null when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.get('test-key');

            expect(result).toBeNull();
            expect(mockClient.get).not.toHaveBeenCalled();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.get.mockRejectedValue(new Error('Redis connection error'));

            const result = await cacheManager.get('test-key');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error getting cache value',
                expect.objectContaining({
                    key: 'test-key',
                    error: 'Redis connection error'
                })
            );
        });
    });

    describe('set', () => {
        it('should set string value without TTL', async () => {
            mockClient.set.mockResolvedValue('OK');

            const result = await cacheManager.set('key', 'value');

            expect(result).toBe(true);
            expect(mockClient.set).toHaveBeenCalledWith('key', 'value');
            expect(logger.debug).toHaveBeenCalledWith(
                'CacheManager',
                'Cache value set',
                expect.objectContaining({ key: 'key', ttlSeconds: null })
            );
        });

        it('should set value with TTL using setex', async () => {
            mockClient.setex.mockResolvedValue('OK');

            const result = await cacheManager.set('key', 'value', 300);

            expect(result).toBe(true);
            expect(mockClient.setex).toHaveBeenCalledWith('key', 300, 'value');
        });

        it('should serialize objects to JSON', async () => {
            mockClient.set.mockResolvedValue('OK');
            const obj = { foo: 'bar', num: 42 };

            const result = await cacheManager.set('key', obj);

            expect(result).toBe(true);
            expect(mockClient.set).toHaveBeenCalledWith('key', JSON.stringify(obj));
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.set('key', 'value');

            expect(result).toBe(false);
            expect(mockClient.set).not.toHaveBeenCalled();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.set.mockRejectedValue(new Error('Set failed'));

            const result = await cacheManager.set('key', 'value');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error setting cache value',
                expect.objectContaining({
                    key: 'key',
                    error: 'Set failed'
                })
            );
        });

        it('should not use setex when TTL is 0', async () => {
            mockClient.set.mockResolvedValue('OK');

            await cacheManager.set('key', 'value', 0);

            expect(mockClient.set).toHaveBeenCalled();
            expect(mockClient.setex).not.toHaveBeenCalled();
        });
    });

    describe('del', () => {
        it('should delete key successfully', async () => {
            mockClient.del.mockResolvedValue(1);

            const result = await cacheManager.del('key');

            expect(result).toBe(true);
            expect(mockClient.del).toHaveBeenCalledWith('key');
            expect(logger.debug).toHaveBeenCalledWith(
                'CacheManager',
                'Cache key deleted',
                { key: 'key' }
            );
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.del('key');

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.del.mockRejectedValue(new Error('Delete failed'));

            const result = await cacheManager.del('key');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error deleting cache key',
                expect.objectContaining({
                    key: 'key',
                    error: 'Delete failed'
                })
            );
        });
    });

    describe('hget', () => {
        it('should return parsed JSON value from hash field', async () => {
            mockClient.hget.mockResolvedValue('{"data":"test"}');

            const result = await cacheManager.hget('hash', 'field');

            expect(result).toEqual({ data: 'test' });
            expect(mockClient.hget).toHaveBeenCalledWith('hash', 'field');
        });

        it('should return string when not valid JSON', async () => {
            mockClient.hget.mockResolvedValue('plain value');

            const result = await cacheManager.hget('hash', 'field');

            expect(result).toBe('plain value');
        });

        it('should return null when field does not exist', async () => {
            mockClient.hget.mockResolvedValue(null);

            const result = await cacheManager.hget('hash', 'nonexistent');

            expect(result).toBeNull();
        });

        it('should return null when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.hget('hash', 'field');

            expect(result).toBeNull();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.hget.mockRejectedValue(new Error('Hget failed'));

            const result = await cacheManager.hget('hash', 'field');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error getting hash field',
                expect.objectContaining({
                    key: 'hash',
                    field: 'field',
                    error: 'Hget failed'
                })
            );
        });
    });

    describe('hset', () => {
        it('should set hash field with string value', async () => {
            mockClient.hset.mockResolvedValue(1);

            const result = await cacheManager.hset('hash', 'field', 'value');

            expect(result).toBe(true);
            expect(mockClient.hset).toHaveBeenCalledWith('hash', 'field', 'value');
            expect(logger.debug).toHaveBeenCalledWith(
                'CacheManager',
                'Hash field set',
                { key: 'hash', field: 'field' }
            );
        });

        it('should serialize objects to JSON', async () => {
            mockClient.hset.mockResolvedValue(1);
            const obj = { test: 'data' };

            await cacheManager.hset('hash', 'field', obj);

            expect(mockClient.hset).toHaveBeenCalledWith('hash', 'field', JSON.stringify(obj));
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.hset('hash', 'field', 'value');

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.hset.mockRejectedValue(new Error('Hset failed'));

            const result = await cacheManager.hset('hash', 'field', 'value');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error setting hash field',
                expect.objectContaining({
                    key: 'hash',
                    field: 'field',
                    error: 'Hset failed'
                })
            );
        });
    });

    describe('hdel', () => {
        it('should delete hash field successfully', async () => {
            mockClient.hdel.mockResolvedValue(1);

            const result = await cacheManager.hdel('hash', 'field');

            expect(result).toBe(true);
            expect(mockClient.hdel).toHaveBeenCalledWith('hash', 'field');
            expect(logger.debug).toHaveBeenCalledWith(
                'CacheManager',
                'Hash field deleted',
                { key: 'hash', field: 'field' }
            );
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.hdel('hash', 'field');

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.hdel.mockRejectedValue(new Error('Hdel failed'));

            const result = await cacheManager.hdel('hash', 'field');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error deleting hash field',
                expect.objectContaining({
                    key: 'hash',
                    field: 'field',
                    error: 'Hdel failed'
                })
            );
        });
    });

    describe('hgetall', () => {
        it('should return all hash fields with parsed JSON values', async () => {
            mockClient.hgetall.mockResolvedValue({
                field1: '{"data":"value1"}',
                field2: 'plain string',
                field3: '123'
            });

            const result = await cacheManager.hgetall('hash');

            expect(result).toEqual({
                field1: { data: 'value1' },
                field2: 'plain string',
                field3: 123
            });
        });

        it('should return null when hash does not exist', async () => {
            mockClient.hgetall.mockResolvedValue({});

            const result = await cacheManager.hgetall('nonexistent');

            expect(result).toBeNull();
        });

        it('should return null when Redis returns null', async () => {
            mockClient.hgetall.mockResolvedValue(null);

            const result = await cacheManager.hgetall('hash');

            expect(result).toBeNull();
        });

        it('should return null when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.hgetall('hash');

            expect(result).toBeNull();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.hgetall.mockRejectedValue(new Error('Hgetall failed'));

            const result = await cacheManager.hgetall('hash');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error getting all hash fields',
                expect.objectContaining({
                    key: 'hash',
                    error: 'Hgetall failed'
                })
            );
        });
    });

    describe('hmset', () => {
        it('should set multiple hash fields', async () => {
            mockClient.hmset.mockResolvedValue('OK');
            const fieldValuePairs = {
                field1: 'value1',
                field2: { nested: 'data' }
            };

            const result = await cacheManager.hmset('hash', fieldValuePairs);

            expect(result).toBe(true);
            expect(mockClient.hmset).toHaveBeenCalledWith('hash', {
                field1: 'value1',
                field2: '{"nested":"data"}'
            });
            expect(logger.debug).toHaveBeenCalledWith(
                'CacheManager',
                'Multiple hash fields set',
                { key: 'hash', fieldCount: 2 }
            );
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.hmset('hash', { field: 'value' });

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.hmset.mockRejectedValue(new Error('Hmset failed'));

            const result = await cacheManager.hmset('hash', { field: 'value' });

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error setting multiple hash fields',
                expect.objectContaining({
                    key: 'hash',
                    error: 'Hmset failed'
                })
            );
        });
    });

    describe('expire', () => {
        it('should set key expiry successfully', async () => {
            mockClient.expire.mockResolvedValue(1);

            const result = await cacheManager.expire('key', 300);

            expect(result).toBe(true);
            expect(mockClient.expire).toHaveBeenCalledWith('key', 300);
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.expire('key', 300);

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.expire.mockRejectedValue(new Error('Expire failed'));

            const result = await cacheManager.expire('key', 300);

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error setting key expiry',
                expect.objectContaining({
                    key: 'key',
                    ttlSeconds: 300,
                    error: 'Expire failed'
                })
            );
        });
    });

    describe('incr', () => {
        it('should increment key and return new value', async () => {
            mockClient.incr.mockResolvedValue(5);

            const result = await cacheManager.incr('counter');

            expect(result).toBe(5);
            expect(mockClient.incr).toHaveBeenCalledWith('counter');
        });

        it('should return null when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await cacheManager.incr('counter');

            expect(result).toBeNull();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.incr.mockRejectedValue(new Error('Incr failed'));

            const result = await cacheManager.incr('counter');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'CacheManager',
                'Error incrementing key',
                expect.objectContaining({
                    key: 'counter',
                    error: 'Incr failed'
                })
            );
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete cache workflow', async () => {
            mockClient.set.mockResolvedValue('OK');
            mockClient.get.mockResolvedValue('{"cached":"data"}');
            mockClient.del.mockResolvedValue(1);

            // Set value
            const setResult = await cacheManager.set('test', { cached: 'data' });
            expect(setResult).toBe(true);

            // Get value
            const getResult = await cacheManager.get('test');
            expect(getResult).toEqual({ cached: 'data' });

            // Delete value
            const delResult = await cacheManager.del('test');
            expect(delResult).toBe(true);
        });

        it('should handle hash operations workflow', async () => {
            mockClient.hmset.mockResolvedValue('OK');
            mockClient.hget.mockResolvedValue('{"response":"test"}');
            mockClient.hgetall.mockResolvedValue({
                cmd1: '{"response":"test1"}',
                cmd2: '{"response":"test2"}'
            });

            // Set multiple fields
            await cacheManager.hmset('commands', {
                cmd1: { response: 'test1' },
                cmd2: { response: 'test2' }
            });

            // Get single field
            const singleResult = await cacheManager.hget('commands', 'cmd1');
            expect(singleResult).toEqual({ response: 'test' });

            // Get all fields
            const allResult = await cacheManager.hgetall('commands');
            expect(allResult).toEqual({
                cmd1: { response: 'test1' },
                cmd2: { response: 'test2' }
            });
        });
    });
});
