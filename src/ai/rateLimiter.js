// src/models/rateLimiter.js
const config = require('../config/config');

class RateLimiter {
    constructor(dbManager) {
        this.dbManager = dbManager;
        this.globalQueues = new Map(); // Track global limits per service
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
            cooldownMs: serviceConfig.cooldowns[userType],
            dailyLimit: serviceConfig.dailyLimits[userType]
        };
    }

    getGlobalLimits(service) {
        const serviceConfig = config.rateLimits[service];
        if (!serviceConfig) {
            return { maxPerMinute: 10 }; // Default fallback
        }
        return { maxPerMinute: serviceConfig.globalMaxPerMinute };
    }

    async checkRateLimit(userId, service, userContext = {}) {
        try {
            // Get user-specific limits from config
            const userLimits = this.getUserLimits(service, userContext);
            
            // Check database for user's usage
            const sql = `
                SELECT last_used, daily_count, reset_date 
                FROM api_usage 
                WHERE user_id = ? AND api_type = ?
            `;
            const results = await this.dbManager.query(sql, [userId, service]);
            
            if (results.length === 0) {
                // First time user - check global limit only
                if (!this.checkGlobalRateLimit(service)) {
                    return { 
                        allowed: false, 
                        reason: 'global_limit',
                        message: `${service.toUpperCase()} is temporarily busy. Please try again in a moment.`
                    };
                }
                return { allowed: true, reason: null };
            }
            
            const usage = results[0];
            const now = new Date();
            const lastUsed = new Date(usage.last_used);
            
            // Check cooldown
            const timeSinceLastUse = now - lastUsed;
            if (timeSinceLastUse < userLimits.cooldownMs) {
                const remainingSeconds = Math.ceil((userLimits.cooldownMs - timeSinceLastUse) / 1000);
                return { 
                    allowed: false, 
                    reason: 'cooldown',
                    remainingSeconds,
                    message: `Please wait ${remainingSeconds} seconds before using ${service.toUpperCase()} again.`
                };
            }
            
            // Check daily limit
            const resetDate = new Date(usage.reset_date);
            const isToday = resetDate.toDateString() === now.toDateString();
            const dailyCount = isToday ? usage.daily_count : 0;
            
            if (dailyCount >= userLimits.dailyLimit) {
                return { 
                    allowed: false, 
                    reason: 'daily_limit',
                    dailyCount,
                    dailyLimit: userLimits.dailyLimit,
                    message: `You've reached your daily ${service.toUpperCase()} limit (${dailyCount}/${userLimits.dailyLimit}). Try again tomorrow!`
                };
            }
            
            // Check global rate limit
            if (!this.checkGlobalRateLimit(service)) {
                return { 
                    allowed: false, 
                    reason: 'global_limit',
                    message: `${service.toUpperCase()} is temporarily busy. Please try again in a moment.`
                };
            }
            
            return { allowed: true, reason: null };
            
        } catch (error) {
            console.error(`❌ Error checking rate limit for ${service}:`, error);
            return { 
                allowed: false, 
                reason: 'error',
                message: `${service.toUpperCase()} is temporarily unavailable.`
            };
        }
    }

    checkGlobalRateLimit(service) {
        const limits = this.getGlobalLimits(service);
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        // Initialize queue for service if it doesn't exist
        if (!this.globalQueues.has(service)) {
            this.globalQueues.set(service, []);
        }
        
        const queue = this.globalQueues.get(service);
        
        // Remove old requests
        const filteredQueue = queue.filter(time => time > oneMinuteAgo);
        this.globalQueues.set(service, filteredQueue);
        
        // Check if we're under the limit
        if (filteredQueue.length >= limits.maxPerMinute) {
            return false;
        }
        
        // Add current request
        filteredQueue.push(now);
        return true;
    }

    async updateUsage(userId, service) {
        try {
            const sql = `
                INSERT INTO api_usage (user_id, api_type, last_used, daily_count, reset_date)
                VALUES (?, ?, NOW(), 1, CURDATE())
                ON DUPLICATE KEY UPDATE 
                    last_used = NOW(),
                    daily_count = CASE 
                        WHEN reset_date = CURDATE() THEN daily_count + 1
                        ELSE 1
                    END,
                    reset_date = CURDATE()
            `;
            await this.dbManager.query(sql, [userId, service]);
        } catch (error) {
            console.error(`❌ Error updating usage for ${service}:`, error);
        }
    }

    async getUserStats(userId, service) {
        try {
            const sql = `
                SELECT daily_count, reset_date, last_used
                FROM api_usage 
                WHERE user_id = ? AND api_type = ?
            `;
            const results = await this.dbManager.query(sql, [userId, service]);
            
            if (results.length === 0) {
                return { dailyCount: 0, lastUsed: null };
            }
            
            const usage = results[0];
            const resetDate = new Date(usage.reset_date);
            const now = new Date();
            const isToday = resetDate.toDateString() === now.toDateString();
            
            return {
                dailyCount: isToday ? usage.daily_count : 0,
                lastUsed: usage.last_used
            };
        } catch (error) {
            console.error(`❌ Error getting user stats for ${service}:`, error);
            return { dailyCount: 0, lastUsed: null };
        }
    }
}

module.exports = RateLimiter;