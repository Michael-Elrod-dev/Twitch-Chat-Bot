// src/analytics/analyticsManager.js

const ViewerTracker = require('./viewers/viewerTracker');

class AnalyticsManager {
    constructor() {
        this.dbManager = null;
        this.currentStreamId = null;
        this.viewerTracker = null;
    }

    async init(dbManager) {
        try {
            this.dbManager = dbManager;
            this.viewerTracker = new ViewerTracker(this);
        } catch (error) {
            console.error('❌ Failed to initialize analytics manager:', error);
            throw error;
        }
    }

    async trackChatMessage(username, userId, streamId, message, type = 'message', userContext = {}) {
        try {
            await this.viewerTracker.trackInteraction(username, userId, streamId, type, message, userContext);

            if (streamId) {
                const updateSql = `
                    UPDATE streams
                    SET total_messages = total_messages + 1
                    WHERE stream_id = ?
                `;
                await this.dbManager.query(updateSql, [streamId]);
            }
        } catch (error) {
            console.error('❌ Error tracking chat message:', error);
        }
    }

    async trackStreamStart(streamId, title, category) {
        try {
            this.currentStreamId = streamId;
            const sql = `
               INSERT INTO streams (stream_id, start_time, title, category)
               VALUES (?, NOW(), ?, ?)
           `;
            await this.dbManager.query(sql, [streamId, title, category]);
        } catch (error) {
            console.error('❌ Error tracking stream start:', error);
        }
    }

    async trackStreamEnd(streamId) {
        try {
            const sql = `
               UPDATE streams
               SET end_time = NOW()
               WHERE stream_id = ?
           `;
            await this.dbManager.query(sql, [streamId]);
            this.currentStreamId = null;
        } catch (error) {
            console.error('❌ Error tracking stream end:', error);
        }
    }
}

module.exports = AnalyticsManager;
