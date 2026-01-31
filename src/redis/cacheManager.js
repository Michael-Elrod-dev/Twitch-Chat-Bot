// src/redis/cacheManager.js

const logger = require('../logger/logger');

class CacheManager {
    constructor(redisManager) {
        this.redisManager = redisManager;
    }

    isAvailable() {
        return this.redisManager && this.redisManager.connected();
    }

    getClient() {
        if (!this.isAvailable()) {
            return null;
        }
        return this.redisManager.getClient();
    }

    async get(key) {
        const client = this.getClient();
        if (!client) {
            return null;
        }

        try {
            const value = await client.get(key);
            if (value === null) {
                return null;
            }

            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } catch (error) {
            logger.error('CacheManager', 'Error getting cache value', {
                key,
                error: error.message
            });
            return null;
        }
    }

    async set(key, value, ttlSeconds = null) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            const serialized = typeof value === 'string' ? value : JSON.stringify(value);

            if (ttlSeconds && ttlSeconds > 0) {
                await client.setex(key, ttlSeconds, serialized);
            } else {
                await client.set(key, serialized);
            }

            logger.debug('CacheManager', 'Cache value set', {
                key,
                ttlSeconds
            });
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error setting cache value', {
                key,
                error: error.message
            });
            return false;
        }
    }

    async del(key) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            await client.del(key);
            logger.debug('CacheManager', 'Cache key deleted', { key });
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error deleting cache key', {
                key,
                error: error.message
            });
            return false;
        }
    }

    async hget(key, field) {
        const client = this.getClient();
        if (!client) {
            return null;
        }

        try {
            const value = await client.hget(key, field);
            if (value === null) {
                return null;
            }

            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } catch (error) {
            logger.error('CacheManager', 'Error getting hash field', {
                key,
                field,
                error: error.message
            });
            return null;
        }
    }

    async hset(key, field, value) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            const serialized = typeof value === 'string' ? value : JSON.stringify(value);
            await client.hset(key, field, serialized);
            logger.debug('CacheManager', 'Hash field set', { key, field });
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error setting hash field', {
                key,
                field,
                error: error.message
            });
            return false;
        }
    }

    async hdel(key, field) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            await client.hdel(key, field);
            logger.debug('CacheManager', 'Hash field deleted', { key, field });
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error deleting hash field', {
                key,
                field,
                error: error.message
            });
            return false;
        }
    }

    async hgetall(key) {
        const client = this.getClient();
        if (!client) {
            return null;
        }

        try {
            const data = await client.hgetall(key);
            if (!data || Object.keys(data).length === 0) {
                return null;
            }

            const result = {};
            for (const [field, value] of Object.entries(data)) {
                try {
                    result[field] = JSON.parse(value);
                } catch {
                    result[field] = value;
                }
            }
            return result;
        } catch (error) {
            logger.error('CacheManager', 'Error getting all hash fields', {
                key,
                error: error.message
            });
            return null;
        }
    }

    async hmset(key, fieldValuePairs) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            const serialized = {};
            for (const [field, value] of Object.entries(fieldValuePairs)) {
                serialized[field] = typeof value === 'string' ? value : JSON.stringify(value);
            }
            await client.hmset(key, serialized);
            logger.debug('CacheManager', 'Multiple hash fields set', {
                key,
                fieldCount: Object.keys(fieldValuePairs).length
            });
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error setting multiple hash fields', {
                key,
                error: error.message
            });
            return false;
        }
    }

    async expire(key, ttlSeconds) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            await client.expire(key, ttlSeconds);
            return true;
        } catch (error) {
            logger.error('CacheManager', 'Error setting key expiry', {
                key,
                ttlSeconds,
                error: error.message
            });
            return false;
        }
    }

    async incr(key) {
        const client = this.getClient();
        if (!client) {
            return null;
        }

        try {
            return await client.incr(key);
        } catch (error) {
            logger.error('CacheManager', 'Error incrementing key', {
                key,
                error: error.message
            });
            return null;
        }
    }
}

module.exports = CacheManager;
