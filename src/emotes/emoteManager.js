// src/emotes/emoteManager.js

const config = require('../config/config');
const logger = require('../logger/logger');

const CACHE_KEY = 'cache:emotes';

class EmoteManager {
    constructor() {
        this.dbManager = null;
        this.redisManager = null;
        this.emoteCache = new Map();
        this.cacheExpiry = null;
        this.cacheTimeout = config.emoteCacheInterval;
    }

    async init(dbManager, redisManager = null) {
        this.dbManager = dbManager;
        this.redisManager = redisManager;
        await this.loadEmotes();
    }

    getCacheManager() {
        if (this.redisManager && this.redisManager.connected()) {
            return this.redisManager.getCacheManager();
        }
        return null;
    }

    async loadEmotes() {
        try {
            const sql = `
                SELECT trigger_text, response_text
                FROM emotes
            `;
            const results = await this.dbManager.query(sql);

            this.emoteCache.clear();
            const cacheData = {};

            for (const row of results) {
                this.emoteCache.set(row.trigger_text.toLowerCase(), row.response_text);
                cacheData[row.trigger_text.toLowerCase()] = row.response_text;
            }

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                await cacheManager.del(CACHE_KEY);
                if (Object.keys(cacheData).length > 0) {
                    await cacheManager.hmset(CACHE_KEY, cacheData);
                    await cacheManager.expire(CACHE_KEY, config.cache.emotesTTL);
                }
                logger.debug('EmoteManager', 'Emotes cached in Redis', {
                    count: Object.keys(cacheData).length
                });
            }

            this.cacheExpiry = Date.now() + this.cacheTimeout;
            logger.info('EmoteManager', 'Emotes loaded successfully', {
                count: this.emoteCache.size,
                redisEnabled: !!cacheManager
            });
        } catch (error) {
            logger.error('EmoteManager', 'Failed to load emotes', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async getEmoteResponse(triggerText) {
        try {
            const normalizedTrigger = triggerText.toLowerCase();

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                const cached = await cacheManager.hget(CACHE_KEY, normalizedTrigger);
                if (cached) {
                    return cached;
                }

                const allCached = await cacheManager.hgetall(CACHE_KEY);
                if (!allCached || Object.keys(allCached).length === 0) {
                    logger.debug('EmoteManager', 'Redis cache empty, reloading emotes');
                    await this.loadEmotes();
                    return this.emoteCache.get(normalizedTrigger) || null;
                }

                return null;
            }

            if (Date.now() > this.cacheExpiry) {
                await this.loadEmotes();
            }

            return this.emoteCache.get(normalizedTrigger) || null;
        } catch (error) {
            logger.error('EmoteManager', 'Failed to get emote response', { error: error.message, stack: error.stack, triggerText });
            return this.emoteCache.get(triggerText.toLowerCase()) || null;
        }
    }

    async addEmote(triggerText, responseText) {
        try {
            const sql = `
                INSERT INTO emotes (trigger_text, response_text)
                VALUES (?, ?)
            `;
            await this.dbManager.query(sql, [triggerText.toLowerCase(), responseText]);

            this.emoteCache.set(triggerText.toLowerCase(), responseText);

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                await cacheManager.hset(CACHE_KEY, triggerText.toLowerCase(), responseText);
            }

            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return false;
            }
            logger.error('EmoteManager', 'Failed to add emote', { error: error.message, stack: error.stack, triggerText, responseText });
            throw error;
        }
    }

    async updateEmote(triggerText, responseText) {
        try {
            const sql = `
                UPDATE emotes
                SET response_text = ?, updated_at = CURRENT_TIMESTAMP
                WHERE trigger_text = ?
            `;
            const result = await this.dbManager.query(sql, [responseText, triggerText.toLowerCase()]);

            if (result.affectedRows > 0) {
                this.emoteCache.set(triggerText.toLowerCase(), responseText);

                const cacheManager = this.getCacheManager();
                if (cacheManager) {
                    await cacheManager.hset(CACHE_KEY, triggerText.toLowerCase(), responseText);
                }

                return true;
            }
            return false;
        } catch (error) {
            logger.error('EmoteManager', 'Failed to update emote', { error: error.message, stack: error.stack, triggerText, responseText });
            throw error;
        }
    }

    async deleteEmote(triggerText) {
        try {
            const sql = `
                DELETE FROM emotes
                WHERE trigger_text = ?
            `;
            const result = await this.dbManager.query(sql, [triggerText.toLowerCase()]);

            if (result.affectedRows > 0) {
                this.emoteCache.delete(triggerText.toLowerCase());

                const cacheManager = this.getCacheManager();
                if (cacheManager) {
                    await cacheManager.hdel(CACHE_KEY, triggerText.toLowerCase());
                }

                return true;
            }
            return false;
        } catch (error) {
            logger.error('EmoteManager', 'Failed to delete emote', { error: error.message, stack: error.stack, triggerText });
            throw error;
        }
    }

    async getAllEmotes() {
        try {
            const sql = `
                SELECT trigger_text, response_text, created_at, updated_at
                FROM emotes
                ORDER BY trigger_text
            `;
            return await this.dbManager.query(sql);
        } catch (error) {
            logger.error('EmoteManager', 'Failed to get all emotes', { error: error.message, stack: error.stack });
            return [];
        }
    }
}

module.exports = EmoteManager;
