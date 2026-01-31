// src/redis/redisManager.js

const Redis = require('ioredis');
const config = require('../config/config');
const logger = require('../logger/logger');
const CacheManager = require('./cacheManager');
const QueueManager = require('./queueManager');

class RedisManager {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.healthCheckInterval = null;
        this.cacheManager = null;
        this.queueManager = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    async init(dbManager) {
        try {
            logger.info('RedisManager', 'Initializing Redis connection', {
                host: config.redis.host,
                port: config.redis.port,
                db: config.redis.db
            });

            this.client = new Redis({
                host: config.redis.host,
                port: config.redis.port,
                password: config.redis.password,
                db: config.redis.db,
                keyPrefix: config.redis.keyPrefix,
                retryStrategy: (times) => {
                    if (times > this.maxReconnectAttempts) {
                        logger.error('RedisManager', 'Max reconnection attempts reached, giving up');
                        return null;
                    }
                    const delay = Math.min(times * 500, 5000);
                    logger.warn('RedisManager', 'Attempting Redis reconnection', {
                        attempt: times,
                        delayMs: delay
                    });
                    return delay;
                },
                lazyConnect: true
            });

            this.setupEventHandlers();

            await this.client.connect();

            await this.ping();
            this.isConnected = true;

            this.cacheManager = new CacheManager(this);
            this.queueManager = new QueueManager(this, dbManager);

            this.startHealthCheck();

            logger.info('RedisManager', 'Redis connection established successfully');
            return true;

        } catch (error) {
            logger.warn('RedisManager', 'Failed to initialize Redis - running in fallback mode', {
                error: error.message
            });
            this.isConnected = false;
            return false;
        }
    }

    setupEventHandlers() {
        this.client.on('connect', () => {
            logger.debug('RedisManager', 'Redis client connecting');
        });

        this.client.on('ready', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            logger.info('RedisManager', 'Redis client ready');
        });

        this.client.on('error', (error) => {
            logger.error('RedisManager', 'Redis client error', {
                error: error.message
            });
        });

        this.client.on('close', () => {
            this.isConnected = false;
            logger.warn('RedisManager', 'Redis connection closed');
        });

        this.client.on('reconnecting', () => {
            this.reconnectAttempts++;
            logger.info('RedisManager', 'Redis client reconnecting', {
                attempt: this.reconnectAttempts
            });
        });

        this.client.on('end', () => {
            this.isConnected = false;
            logger.warn('RedisManager', 'Redis connection ended');
        });
    }

    startHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        this.healthCheckInterval = setInterval(async () => {
            try {
                await this.ping();
                if (!this.isConnected) {
                    this.isConnected = true;
                    logger.info('RedisManager', 'Redis connection restored');
                }
            } catch (error) {
                if (this.isConnected) {
                    this.isConnected = false;
                    logger.warn('RedisManager', 'Redis health check failed', {
                        error: error.message
                    });
                }
            }
        }, 30000);
    }

    async ping() {
        if (!this.client) {
            throw new Error('Redis client not initialized');
        }
        const result = await this.client.ping();
        if (result !== 'PONG') {
            throw new Error(`Unexpected ping response: ${result}`);
        }
        return true;
    }

    connected() {
        return this.isConnected && this.client !== null;
    }

    getClient() {
        return this.client;
    }

    getCacheManager() {
        return this.cacheManager;
    }

    getQueueManager() {
        return this.queueManager;
    }

    async close() {
        logger.info('RedisManager', 'Closing Redis connection');

        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        if (this.queueManager) {
            try {
                await this.queueManager.stopConsumer();
                logger.debug('RedisManager', 'Queue consumer stopped');
            } catch (error) {
                logger.error('RedisManager', 'Error stopping queue consumer', {
                    error: error.message
                });
            }
        }

        if (this.client) {
            try {
                await this.client.quit();
                logger.info('RedisManager', 'Redis connection closed gracefully');
            } catch (error) {
                logger.error('RedisManager', 'Error closing Redis connection', {
                    error: error.message
                });
                this.client.disconnect();
            }
        }

        this.isConnected = false;
        this.client = null;
    }

    async drainQueues(timeoutMs) {
        if (!this.queueManager) {
            logger.debug('RedisManager', 'No queue manager to drain');
            return;
        }

        return this.queueManager.drainQueues(timeoutMs);
    }
}

module.exports = RedisManager;
