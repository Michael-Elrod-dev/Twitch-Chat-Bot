// src/emotes/emoteManager.js
const config = require('../config/config');

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
            
            // Clear and rebuild cache
            this.emoteCache.clear();
            for (const row of results) {
                this.emoteCache.set(row.trigger_text.toLowerCase(), row.response_text);
            }
            
            this.cacheExpiry = Date.now() + this.cacheTimeout;
            console.log(`✅ Loaded ${this.emoteCache.size} emotes`);
        } catch (error) {
            console.error('❌ Error loading emotes:', error);
            throw error;
        }
    }

    async getEmoteResponse(triggerText) {
        try {
            // Check if cache needs refresh
            if (Date.now() > this.cacheExpiry) {
                await this.loadEmotes();
            }
            
            return this.emoteCache.get(triggerText.toLowerCase()) || null;
        } catch (error) {
            console.error('❌ Error getting emote response:', error);
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
            
            // Update cache
            this.emoteCache.set(triggerText.toLowerCase(), responseText);
            
            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return false; // Emote already exists
            }
            console.error('❌ Error adding emote:', error);
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
                // Update cache
                this.emoteCache.set(triggerText.toLowerCase(), responseText);
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Error updating emote:', error);
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
                // Remove from cache
                this.emoteCache.delete(triggerText.toLowerCase());
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Error deleting emote:', error);
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
            console.error('❌ Error getting all emotes:', error);
            return [];
        }
    }
}

module.exports = EmoteManager;