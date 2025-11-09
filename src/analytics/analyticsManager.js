// src/analytics/analyticsManager.js

const ViewerTracker = require('./viewers/viewerTracker');
const logger = require('../logger/logger');

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
            logger.info('AnalyticsManager', 'Analytics manager initialized successfully');
        } catch (error) {
            logger.error('AnalyticsManager', 'Failed to initialize analytics manager', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Track a chat message, command, or redemption
     * @param {string} username - The username
     * @param {string} userId - The user ID
     * @param {string} streamId - The stream ID
     * @param {string} message - The message content
     * @param {string} type - The type of interaction ('message', 'command', or 'redemption')
     * @param {Object} userContext - User context object
     * @param {boolean} userContext.isMod - Whether user is a moderator
     * @param {boolean} userContext.isSubscriber - Whether user is a subscriber
     * @param {boolean} userContext.isBroadcaster - Whether user is the broadcaster
     */
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
                logger.debug('AnalyticsManager', 'Chat message tracked', {
                    username,
                    userId,
                    streamId,
                    type
                });
            }
        } catch (error) {
            logger.error('AnalyticsManager', 'Error tracking chat message', {
                error: error.message,
                stack: error.stack,
                username,
                userId,
                streamId,
                type
            });
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
            logger.info('AnalyticsManager', 'Stream started', {
                streamId,
                title,
                category
            });
        } catch (error) {
            logger.error('AnalyticsManager', 'Error tracking stream start', {
                error: error.message,
                stack: error.stack,
                streamId,
                title,
                category
            });
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
            logger.info('AnalyticsManager', 'Stream ended', { streamId });
        } catch (error) {
            logger.error('AnalyticsManager', 'Error tracking stream end', {
                error: error.message,
                stack: error.stack,
                streamId
            });
        }
    }
}

module.exports = AnalyticsManager;
