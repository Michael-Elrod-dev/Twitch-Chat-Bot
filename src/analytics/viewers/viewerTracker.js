// src/analytics/viewers/viewerTracker.js
class ViewerTracker {
    constructor(analyticsManager) {
        this.analyticsManager = analyticsManager;
    }

    async ensureUserExists(username, userId = null) {
        try {
            if (!userId) {
                userId = username; // Use username as ID if no Twitch ID available
            }

            const sql = `
                INSERT IGNORE INTO viewers (user_id, username, last_seen)
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE last_seen = NOW(), username = ?
            `;
            await this.analyticsManager.dbManager.query(sql, [userId, username, username]);
            return userId;
        } catch (error) {
            console.error('❌ Error ensuring user exists:', error);
            throw error;
        }
    }

    async trackInteraction(username, userId, streamId, type, content = null) {
        try {
            if (!username) {
                console.error('Attempted to track interaction for undefined username');
                return;
            }

            // Ensure user exists in database
            const dbUserId = await this.ensureUserExists(username, userId);

            // Track in database
            const sql = `
                INSERT INTO chat_messages (user_id, stream_id, message_time, message_type, message_content) 
                VALUES (?, ?, NOW(), ?, ?)
            `;
            await this.analyticsManager.dbManager.query(sql, [dbUserId, streamId, type, content]);

            // Update viewing session metrics
            await this.updateViewingSession(dbUserId, streamId);
        } catch (error) {
            console.error(`❌ Error tracking ${type} for ${username}:`, error);
        }
    }

    async updateViewingSession(userId, streamId) {
        try {
            // Check if session exists
            const checkSql = `
                SELECT session_id FROM viewing_sessions 
                WHERE user_id = ? AND stream_id = ? AND end_time IS NULL
            `;
            const sessions = await this.analyticsManager.dbManager.query(checkSql, [userId, streamId]);
            
            if (sessions.length === 0) {
                // Create new session
                const insertSql = `
                    INSERT INTO viewing_sessions (user_id, stream_id, start_time, messages_sent)
                    VALUES (?, ?, NOW(), 1)
                `;
                await this.analyticsManager.dbManager.query(insertSql, [userId, streamId]);
            } else {
                // Update existing session
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

    // Analytics retrieval methods
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
            const sql = `SELECT user_id FROM viewers WHERE LOWER(username) = LOWER(?)`;
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
    
    async getTopUsers() {
        try {
            const sql = `
                SELECT v.username, 
                       SUM(CASE WHEN cm.message_type = 'message' THEN 1 ELSE 0 END) as messages,
                       SUM(CASE WHEN cm.message_type = 'command' THEN 1 ELSE 0 END) as commands,
                       SUM(CASE WHEN cm.message_type = 'redemption' THEN 1 ELSE 0 END) as redemptions,
                       COUNT(*) as total
                FROM viewers v
                JOIN chat_messages cm ON v.user_id = cm.user_id
                GROUP BY v.username
                ORDER BY total DESC
                LIMIT 5
            `;
            
            const results = await this.analyticsManager.dbManager.query(sql, [limit]);
            
            return results.map((user, index) => 
                `${index + 1}. ${user.username}: ${user.total} total interactions`
            );
        } catch (error) {
            console.error('❌ Error getting top users:', error);
            return [];
        }
    }
}

module.exports = ViewerTracker;