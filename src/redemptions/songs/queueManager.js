// src/redemptions/songs/queueManager.js
class QueueManager {
    constructor() {
        this.dbManager = null;
    }

    async init(dbManager) {
        this.dbManager = dbManager;
        console.log('✅ QueueManager initialized with database');
    }

    async addToPendingQueue(track) {
        try {
            // Get the next position (end of queue)
            const positionSql = `SELECT COALESCE(MAX(queue_position), 0) + 1 as next_position FROM song_queue`;
            const positionResult = await this.dbManager.query(positionSql);
            const nextPosition = positionResult[0].next_position;

            const sql = `
                INSERT INTO song_queue (track_uri, track_name, artist_name, requested_by, queue_position, added_at)
                VALUES (?, ?, ?, ?, ?, NOW())
            `;
            await this.dbManager.query(sql, [
                track.uri,
                track.name,
                track.artist,
                track.requestedBy,
                nextPosition
            ]);
        } catch (error) {
            console.error('❌ Error adding to pending queue:', error);
            throw error;
        }
    }

    async addToPriorityQueue(track) {
        try {
            await this.dbManager.query('START TRANSACTION');

            // Increment all existing positions
            const incrementSql = `UPDATE song_queue SET queue_position = queue_position + 1`;
            await this.dbManager.query(incrementSql);

            // Add new track at position 1
            const insertSql = `
                INSERT INTO song_queue (track_uri, track_name, artist_name, requested_by, queue_position, added_at)
                VALUES (?, ?, ?, ?, 1, NOW())
            `;
            await this.dbManager.query(insertSql, [
                track.uri,
                track.name,
                track.artist,
                track.requestedBy
            ]);

            await this.dbManager.query('COMMIT');
        } catch (error) {
            try {
                await this.dbManager.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('❌ Error rolling back transaction:', rollbackError);
            }
            console.error('❌ Error adding to priority queue:', error);
            throw error;
        }
    }

    async clearQueue() {
        try {
            const sql = `DELETE FROM song_queue`;
            await this.dbManager.query(sql);
        } catch (error) {
            console.error('❌ Error clearing queue:', error);
            throw error;
        }
    }

    async getPendingTracks() {
        try {
            const sql = `
                SELECT track_uri as uri, track_name as name, artist_name as artist, 
                       requested_by as requestedBy, added_at as addedAt
                FROM song_queue 
                ORDER BY queue_position ASC
            `;
            const results = await this.dbManager.query(sql);
            return results;
        } catch (error) {
            console.error('❌ Error getting pending tracks:', error);
            return [];
        }
    }

    async removeFirstTrack() {
        try {
            await this.dbManager.query('START TRANSACTION');

            // Remove the first track (position 1)
            const deleteSql = `DELETE FROM song_queue WHERE queue_position = 1`;
            await this.dbManager.query(deleteSql);

            // Decrement all remaining positions
            const updateSql = `UPDATE song_queue SET queue_position = queue_position - 1`;
            await this.dbManager.query(updateSql);

            await this.dbManager.query('COMMIT');
        } catch (error) {
            await this.dbManager.query('ROLLBACK');
            console.error('❌ Error removing first track:', error);
            throw error;
        }
    }
}

module.exports = QueueManager;