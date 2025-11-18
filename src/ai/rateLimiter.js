// src/ai/rateLimiter.js

const config = require('../config/config');
const logger = require('../logger/logger');

class RateLimiter {
    constructor(dbManager) {
        this.dbManager = dbManager;
    }

    getUserLimits(service, userContext = {}) {
        const serviceConfig = config.rateLimits[service];
        if (!serviceConfig) {
            throw new Error(`No rate limit config found for service: ${service}`);
        }

        let userType = 'everyone';
        if (userContext.isBroadcaster) userType = 'broadcaster';
        else if (userContext.isMod) userType = 'mod';
        else if (userContext.isSubscriber) userType = 'subscriber';

        return {
            streamLimit: serviceConfig.streamLimits[userType]
        };
    }

    async checkRateLimit(userId, service, streamId, userContext = {}) {
        try {
            const userLimits = this.getUserLimits(service, userContext);

            const sql = `
                SELECT stream_count
                FROM api_usage
                WHERE user_id = ? AND api_type = ? AND stream_id = ?
            `;
            const results = await this.dbManager.query(sql, [userId, service, streamId]);

            const currentCount = results.length > 0 ? results[0].stream_count : 0;

            logger.debug('RateLimiter', 'Checking rate limit', {
                userId,
                userName: userContext.userName,
                service,
                currentCount,
                streamLimit: userLimits.streamLimit,
                streamId
            });

            if (currentCount >= userLimits.streamLimit) {
                logger.info('RateLimiter', 'Rate limit exceeded', {
                    userId,
                    userName: userContext.userName,
                    service,
                    streamCount: currentCount,
                    streamLimit: userLimits.streamLimit
                });
                return {
                    allowed: false,
                    reason: 'stream_limit',
                    streamCount: currentCount,
                    streamLimit: userLimits.streamLimit,
                    message: `You've reached your ${service.toUpperCase()} limit for this stream (${currentCount}/${userLimits.streamLimit}).`
                };
            }

            return { allowed: true, reason: null };

        } catch (error) {
            logger.error('RateLimiter', 'Error checking rate limit', {
                error: error.message,
                stack: error.stack,
                userId,
                userName: userContext.userName,
                service,
                streamId
            });
            return {
                allowed: false,
                reason: 'error',
                message: config.errorMessages.ai.globalLimit
            };
        }
    }

    async updateUsage(userId, service, streamId) {
        try {
            const sql = `
                INSERT INTO api_usage (user_id, api_type, stream_id, stream_count)
                VALUES (?, ?, ?, 1)
                ON DUPLICATE KEY UPDATE
                    stream_count = stream_count + 1
            `;
            await this.dbManager.query(sql, [userId, service, streamId]);
            logger.debug('RateLimiter', 'Usage updated', {
                userId,
                service,
                streamId
            });
        } catch (error) {
            logger.error('RateLimiter', 'Error updating usage', {
                error: error.message,
                stack: error.stack,
                userId,
                service,
                streamId
            });
        }
    }

    async getUserStats(userId, service, streamId) {
        try {
            const sql = `
                SELECT stream_count
                FROM api_usage
                WHERE user_id = ? AND api_type = ? AND stream_id = ?
            `;
            const results = await this.dbManager.query(sql, [userId, service, streamId]);

            return {
                streamCount: results.length > 0 ? results[0].stream_count : 0
            };
        } catch (error) {
            logger.error('RateLimiter', 'Error getting user stats', {
                error: error.message,
                stack: error.stack,
                userId,
                service,
                streamId
            });
            return { streamCount: 0 };
        }
    }
}

module.exports = RateLimiter;
