// src/ai/contextBuilder.js

const logger = require('../logger/logger.js');


class ContextBuilder {
    constructor(dbManager) {
        this.dbManager = dbManager;
        this.logger = logger;
    }

    async getChatHistory(streamId, limit = 50) {
        try {
            const sql = `
                SELECT
                    v.username,
                    cm.message_content,
                    cm.message_time,
                    cm.message_type
                FROM chat_messages cm
                JOIN viewers v ON cm.user_id = v.user_id
                WHERE cm.stream_id = ?
                ORDER BY cm.message_time DESC
                LIMIT ${parseInt(limit)}
            `;

            const results = await this.dbManager.query(sql, [streamId]);

            return results.reverse();
        } catch (error) {
            this.logger.error('Error fetching chat history:', error);
            return [];
        }
    }

    async getStreamContext(streamId) {
        try {
            const sql = `
                SELECT
                    title,
                    category,
                    start_time,
                    total_messages,
                    unique_chatters
                FROM streams
                WHERE stream_id = ?
            `;

            const results = await this.dbManager.query(sql, [streamId]);

            if (results.length === 0) {
                return null;
            }

            const stream = results[0];

            const duration = this.calculateStreamDuration(stream.start_time);

            return {
                title: stream.title || 'No title',
                category: stream.category || 'No category',
                duration: duration,
                totalMessages: stream.total_messages || 0,
                uniqueChatters: stream.unique_chatters || 0
            };
        } catch (error) {
            this.logger.error('Error fetching stream context:', error);
            return null;
        }
    }

    async getUserRoles() {
        try {
            const sql = `
                SELECT
                    username,
                    is_broadcaster,
                    is_moderator
                FROM viewers
                WHERE is_broadcaster = TRUE OR is_moderator = TRUE
            `;

            const results = await this.dbManager.query(sql);

            const broadcaster = results
                .filter(user => user.is_broadcaster)
                .map(user => user.username);

            const mods = results
                .filter(user => user.is_moderator && !user.is_broadcaster)
                .map(user => user.username);

            return {
                broadcaster: broadcaster[0] || 'Unknown',
                mods: mods
            };
        } catch (error) {
            this.logger.error('Error fetching user roles:', error);
            return {
                broadcaster: 'Unknown',
                mods: []
            };
        }
    }

    async getUserProfile(userId) {
        try {
            const sql = `
                SELECT
                    username,
                    context
                FROM viewers
                WHERE user_id = ?
            `;

            const results = await this.dbManager.query(sql, [userId]);

            if (results.length === 0) {
                return null;
            }

            const user = results[0];

            if (!user.context) {
                return null;
            }

            return {
                username: user.username,
                context: user.context
            };
        } catch (error) {
            this.logger.error('Error fetching user profile:', error);
            return null;
        }
    }

    calculateStreamDuration(startTime) {
        const now = new Date();
        const start = new Date(startTime);
        const diffMs = now - start;

        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    async getAllContext(streamId, chatHistoryLimit = 50) {
        try {
            const [chatHistory, streamContext, userRoles] = await Promise.all([
                this.getChatHistory(streamId, chatHistoryLimit),
                this.getStreamContext(streamId),
                this.getUserRoles()
            ]);

            return {
                chatHistory,
                streamContext,
                userRoles
            };
        } catch (error) {
            this.logger.error('Error fetching all context:', error);
            return {
                chatHistory: [],
                streamContext: null,
                userRoles: { broadcaster: 'Unknown', mods: [] }
            };
        }
    }
}

module.exports = ContextBuilder;
