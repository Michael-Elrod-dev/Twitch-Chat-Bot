// src/analytics/viewers/viewerTracker.js

const logger = require('../../logger/logger');

class ViewerTracker {
    constructor(analyticsManager) {
        this.analyticsManager = analyticsManager;
    }

    async ensureUserExists(username, userId = null, isMod = false, isSubscriber = false, isBroadcaster = false) {
        try {
            if (!userId) {
                userId = username;
            }

            const sql = `
                INSERT IGNORE INTO viewers (user_id, username, is_moderator, is_subscriber, is_broadcaster, last_seen)
                VALUES (?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    last_seen = NOW(),
                    username = ?,
                    is_moderator = ?,
                    is_subscriber = ?,
                    is_broadcaster = ?
            `;
            await this.analyticsManager.dbManager.query(sql, [
                userId, username, isMod, isSubscriber, isBroadcaster,
                username, isMod, isSubscriber, isBroadcaster
            ]);
            logger.debug('ViewerTracker', 'User record ensured', {
                username,
                userId,
                isMod,
                isSubscriber,
                isBroadcaster
            });
            return userId;
        } catch (error) {
            logger.error('ViewerTracker', 'Error ensuring user exists', {
                error: error.message,
                stack: error.stack,
                username,
                userId
            });
            throw error;
        }
    }

    /**
     * Track a user interaction
     * @param {string} username - The username
     * @param {string} userId - The user ID
     * @param {string} streamId - The stream ID
     * @param {string} type - The type of interaction
     * @param {string|null} content - The content of the interaction
     * @param {Object} userContext - User context object
     * @param {boolean} userContext.isMod - Whether user is a moderator
     * @param {boolean} userContext.isSubscriber - Whether user is a subscriber
     * @param {boolean} userContext.isBroadcaster - Whether user is the broadcaster
     */
    async trackInteraction(username, userId, streamId, type, content = null, userContext = {}) {
        try {
            if (!username) {
                logger.warn('ViewerTracker', 'Attempted to track interaction for undefined username', {
                    userId,
                    streamId,
                    type
                });
                return;
            }

            const isMod = userContext.isMod || false;
            const isSubscriber = userContext.isSubscriber || false;
            const isBroadcaster = userContext.isBroadcaster || false;
            const dbUserId = await this.ensureUserExists(username, userId, isMod, isSubscriber, isBroadcaster);

            const checkFirstMessageSql = `
                SELECT COUNT(*) as count FROM chat_messages
                WHERE user_id = ? AND stream_id = ?
            `;
            const result = await this.analyticsManager.dbManager.query(checkFirstMessageSql, [dbUserId, streamId]);

            if (result[0].count === 0) {
                const updateUniqueSql = `
                    UPDATE streams
                    SET unique_chatters = unique_chatters + 1
                    WHERE stream_id = ?
                `;
                await this.analyticsManager.dbManager.query(updateUniqueSql, [streamId]);
                logger.debug('ViewerTracker', 'New unique chatter detected', {
                    username,
                    userId: dbUserId,
                    streamId
                });
            }

            const sql = `
                INSERT INTO chat_messages (user_id, stream_id, message_time, message_type, message_content)
                VALUES (?, ?, NOW(), ?, ?)
            `;
            await this.analyticsManager.dbManager.query(sql, [dbUserId, streamId, type, content]);
            await this.updateChatTotals(dbUserId, type);
            logger.debug('ViewerTracker', 'Interaction tracked', {
                username,
                userId: dbUserId,
                streamId,
                type
            });
        } catch (error) {
            logger.error('ViewerTracker', `Error tracking ${type} for ${username}`, {
                error: error.message,
                stack: error.stack,
                username,
                userId,
                streamId,
                type
            });
        }
    }

    async updateChatTotals(userId, messageType) {
        try {
            let updateColumn;
            switch (messageType) {
            case 'message':
                updateColumn = 'message_count';
                break;
            case 'command':
                updateColumn = 'command_count';
                break;
            case 'redemption':
                updateColumn = 'redemption_count';
                break;
            default:
                logger.error('ViewerTracker', `Unknown message type: ${messageType}`, { userId, messageType });
                return;
            }

            const sql = `
                INSERT INTO chat_totals (user_id, ${updateColumn}, total_count)
                VALUES (?, 1, 1)
                ON DUPLICATE KEY UPDATE
                    ${updateColumn} = ${updateColumn} + 1,
                    total_count = total_count + 1
            `;

            await this.analyticsManager.dbManager.query(sql, [userId]);
            logger.debug('ViewerTracker', 'Chat totals updated', { userId, messageType, updateColumn });
        } catch (error) {
            logger.error('ViewerTracker', 'Error updating chat totals', {
                error: error.message,
                stack: error.stack,
                userId,
                messageType
            });
        }
    }

    async getActiveSession(userId, streamId) {
        try {
            const sql = `
                SELECT session_id FROM viewing_sessions
                WHERE user_id = ? AND stream_id = ? AND end_time IS NULL
            `;
            const sessions = await this.analyticsManager.dbManager.query(sql, [userId, streamId]);
            const sessionId = sessions.length > 0 ? sessions[0].session_id : null;
            logger.debug('ViewerTracker', 'Active session retrieved', { userId, streamId, sessionId });
            return sessionId;
        } catch (error) {
            logger.error('ViewerTracker', 'Error getting active session', {
                error: error.message,
                stack: error.stack,
                userId,
                streamId
            });
            return null;
        }
    }

    async startSession(userId, streamId) {
        try {
            const sql = `
                INSERT INTO viewing_sessions (user_id, stream_id, start_time)
                VALUES (?, ?, NOW())
            `;
            await this.analyticsManager.dbManager.query(sql, [userId, streamId]);
            logger.info('ViewerTracker', 'Viewing session started', { userId, streamId });
        } catch (error) {
            logger.error('ViewerTracker', 'Error starting session', {
                error: error.message,
                stack: error.stack,
                userId,
                streamId
            });
        }
    }

    async endSession(sessionId) {
        try {
            const sql = `
                UPDATE viewing_sessions
                SET end_time = NOW()
                WHERE session_id = ?
            `;
            await this.analyticsManager.dbManager.query(sql, [sessionId]);
            logger.info('ViewerTracker', 'Viewing session ended', { sessionId });
        } catch (error) {
            logger.error('ViewerTracker', 'Error ending session', {
                error: error.message,
                stack: error.stack,
                sessionId
            });
        }
    }

    async endAllSessionsForStream(streamId) {
        try {
            const sql = `
                UPDATE viewing_sessions
                SET end_time = NOW()
                WHERE stream_id = ? AND end_time IS NULL
            `;
            const result = await this.analyticsManager.dbManager.query(sql, [streamId]);
            logger.info('ViewerTracker', 'Closed all viewing sessions for stream', {
                streamId,
                affectedRows: result.affectedRows
            });
        } catch (error) {
            logger.error('ViewerTracker', 'Error ending all sessions for stream', {
                error: error.message,
                stack: error.stack,
                streamId
            });
        }
    }

    async processViewerList(viewers, streamId) {
        try {
            if (!viewers || viewers.length === 0) {
                logger.debug('ViewerTracker', 'Empty viewer list received', { streamId });
                return;
            }

            // Create a set of current viewer IDs for quick lookup
            const currentViewerIds = new Set(viewers.map(v => v.user_id));

            // 1. Process current viewers - start sessions for new viewers
            let newSessions = 0;
            for (const viewer of viewers) {
                const userId = viewer.user_id;
                const username = viewer.user_login;

                // Ensure user exists in viewers table
                await this.ensureUserExists(username, userId);

                // Check if user has active session
                const activeSession = await this.getActiveSession(userId, streamId);

                // If no active session, start one
                if (!activeSession) {
                    await this.startSession(userId, streamId);
                    newSessions++;
                }
            }

            // 2. Find viewers who left - end their sessions
            const activeSql = `
                SELECT session_id, user_id FROM viewing_sessions
                WHERE stream_id = ? AND end_time IS NULL
            `;
            const activeSessions = await this.analyticsManager.dbManager.query(activeSql, [streamId]);

            let endedSessions = 0;
            for (const session of activeSessions) {
                // If user no longer in current viewer list, end their session
                if (!currentViewerIds.has(session.user_id)) {
                    await this.endSession(session.session_id);
                    endedSessions++;
                }
            }

            logger.debug('ViewerTracker', 'Viewer list processed', {
                streamId,
                totalViewers: viewers.length,
                newSessions,
                endedSessions,
                activeSessions: activeSessions.length
            });
        } catch (error) {
            logger.error('ViewerTracker', 'Error processing viewer list', {
                error: error.message,
                stack: error.stack,
                streamId,
                viewerCount: viewers ? viewers.length : 0
            });
        }
    }

    async getUserStats(username) {
        try {
            const userId = await this.getUserId(username);
            if (!userId) {
                logger.debug('ViewerTracker', 'User not found for stats', { username });
                return null;
            }

            const sql = `
                SELECT SUM(IF(message_type = 'message', 1, 0)) as messages,
                       SUM(IF(message_type = 'command', 1, 0)) as commands,
                       SUM(IF(message_type = 'redemption', 1, 0)) as redemptions
                FROM chat_messages
                WHERE user_id = ?
            `;
            const results = await this.analyticsManager.dbManager.query(sql, [userId]);

            if (results.length === 0) {
                logger.debug('ViewerTracker', 'No stats found for user', { username, userId });
                return null;
            }

            const stats = {
                messages: parseInt(results[0].messages) || 0,
                commands: parseInt(results[0].commands) || 0,
                redemptions: parseInt(results[0].redemptions) || 0
            };
            logger.debug('ViewerTracker', 'User stats retrieved', { username, userId, stats });
            return stats;
        } catch (error) {
            logger.error('ViewerTracker', 'Error getting user stats', {
                error: error.message,
                stack: error.stack,
                username
            });
            return null;
        }
    }

    async getUserId(username) {
        try {
            const sql = 'SELECT user_id FROM viewers WHERE LOWER(username) = LOWER(?)';
            const results = await this.analyticsManager.dbManager.query(sql, [username]);
            const userId = results.length > 0 ? results[0].user_id : null;
            logger.debug('ViewerTracker', 'User ID lookup', { username, userId });
            return userId;
        } catch (error) {
            logger.error('ViewerTracker', 'Error getting user ID', {
                error: error.message,
                stack: error.stack,
                username
            });
            return null;
        }
    }

    async getUserMessages(username) {
        const stats = await this.getUserStats(username);
        return stats ? stats.messages : 0;
    }

    async getUserCommands(username) {
        const stats = await this.getUserStats(username);
        return stats ? stats.commands : 0;
    }

    async getUserRedemptions(username) {
        const stats = await this.getUserStats(username);
        return stats ? stats.redemptions : 0;
    }

    async getUserTotal(username) {
        const stats = await this.getUserStats(username);
        if (!stats) return 0;
        return stats.messages + stats.commands + stats.redemptions;
    }

    async getTopUsers(limit = 5) {
        try {
            const limitNum = parseInt(limit);
            const safeLimit = isNaN(limitNum) || limitNum <= 0 ? 5 : limitNum;

            const sql = `
                SELECT v.username,
                       COUNT(*) as total
                FROM viewers v
                JOIN chat_messages cm ON v.user_id = cm.user_id
                GROUP BY v.username
                ORDER BY total DESC
                LIMIT ${safeLimit}
            `;

            const results = await this.analyticsManager.dbManager.query(sql);

            logger.debug('ViewerTracker', 'Top users retrieved', {
                limit: safeLimit,
                resultCount: results.length
            });

            return results.map((user, index) =>
                `${index + 1}. ${user.username}`
            );
        } catch (error) {
            logger.error('ViewerTracker', 'Error getting top users', {
                error: error.message,
                stack: error.stack,
                limit
            });
            return [];
        }
    }
}

module.exports = ViewerTracker;
