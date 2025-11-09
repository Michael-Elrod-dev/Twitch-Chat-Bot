// src/analytics/viewers/viewerTracker.js

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
            return userId;
        } catch (error) {
            console.error('❌ Error ensuring user exists:', error);
            throw error;
        }
    }

    async trackInteraction(username, userId, streamId, type, content = null, userContext = {}) {
        try {
            if (!username) {
                console.error('Attempted to track interaction for undefined username');
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
            }

            const sql = `
                INSERT INTO chat_messages (user_id, stream_id, message_time, message_type, message_content)
                VALUES (?, ?, NOW(), ?, ?)
            `;
            await this.analyticsManager.dbManager.query(sql, [dbUserId, streamId, type, content]);
            await this.updateViewingSession(dbUserId, streamId);
            await this.updateChatTotals(dbUserId, type);
        } catch (error) {
            console.error(`❌ Error tracking ${type} for ${username}:`, error);
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
                console.error(`Unknown message type: ${messageType}`);
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
        } catch (error) {
            console.error('❌ Error updating chat totals:', error);
        }
    }

    async updateViewingSession(userId, streamId) {
        try {
            const checkSql = `
                SELECT session_id FROM viewing_sessions
                WHERE user_id = ? AND stream_id = ? AND end_time IS NULL
            `;
            const sessions = await this.analyticsManager.dbManager.query(checkSql, [userId, streamId]);

            if (sessions.length === 0) {
                const insertSql = `
                    INSERT INTO viewing_sessions (user_id, stream_id, start_time, messages_sent)
                    VALUES (?, ?, NOW(), 1)
                `;
                await this.analyticsManager.dbManager.query(insertSql, [userId, streamId]);
            } else {
                const updateSql = `
                    UPDATE viewing_sessions
                    SET messages_sent = messages_sent + 1
                    WHERE session_id = ?
                `;
                await this.analyticsManager.dbManager.query(updateSql, [sessions[0].session_id]);
            }
        } catch (error) {
            console.error('❌ Error updating viewing session:', error);
        }
    }

    async getUserStats(username) {
        try {
            const userId = await this.getUserId(username);
            if (!userId) return null;

            const sql = `
                SELECT
                    SUM(CASE WHEN message_type = 'message' THEN 1 ELSE 0 END) as messages,
                    SUM(CASE WHEN message_type = 'command' THEN 1 ELSE 0 END) as commands,
                    SUM(CASE WHEN message_type = 'redemption' THEN 1 ELSE 0 END) as redemptions
                FROM chat_messages
                WHERE user_id = ?
            `;
            const results = await this.analyticsManager.dbManager.query(sql, [userId]);

            if (results.length === 0) {
                return null;
            }

            return {
                messages: parseInt(results[0].messages) || 0,
                commands: parseInt(results[0].commands) || 0,
                redemptions: parseInt(results[0].redemptions) || 0
            };
        } catch (error) {
            console.error('❌ Error getting user stats:', error);
            return null;
        }
    }

    async getUserId(username) {
        try {
            const sql = 'SELECT user_id FROM viewers WHERE LOWER(username) = LOWER(?)';
            const results = await this.analyticsManager.dbManager.query(sql, [username]);
            return results.length > 0 ? results[0].user_id : null;
        } catch (error) {
            console.error('❌ Error getting user ID:', error);
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

            return results.map((user, index) =>
                `${index + 1}. ${user.username}`
            );
        } catch (error) {
            console.error('❌ Error getting top users:', error);
            return [];
        }
    }
}

module.exports = ViewerTracker;
