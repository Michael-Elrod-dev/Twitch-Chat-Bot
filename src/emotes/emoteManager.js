// src/emotes/emoteManager.js

const config = require('../config/config');
const logger = require('../logger/logger');

class EmoteManager {
    constructor() {
        this.dbManager = null;
        this.emoteCache = new Map();
        this.cacheExpiry = null;
        this.cacheTimeout = config.emoteCacheInterval;
    }

    async init(dbManager) {
        this.dbManager = dbManager;
        await this.loadEmotes();
    }

    async loadEmotes() {
        try {
            const sql = `
                SELECT trigger_text, response_text
                FROM emotes
            `;
            const results = await this.dbManager.query(sql);

            this.emoteCache.clear();
            for (const row of results) {
                this.emoteCache.set(row.trigger_text.toLowerCase(), row.response_text);
            }

            this.cacheExpiry = Date.now() + this.cacheTimeout;
            logger.info('EmoteManager', 'Emotes loaded successfully', { count: this.emoteCache.size });
        } catch (error) {
            logger.error('EmoteManager', 'Failed to load emotes', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async getEmoteResponse(triggerText) {
        try {
            if (Date.now() > this.cacheExpiry) {
                await this.loadEmotes();
            }

            return this.emoteCache.get(triggerText.toLowerCase()) || null;
        } catch (error) {
            logger.error('EmoteManager', 'Failed to get emote response', { error: error.message, stack: error.stack, triggerText });
            return null;
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
