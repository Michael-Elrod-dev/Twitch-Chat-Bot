const logger = require('../../logger/logger');

class QueueManager {
    constructor() {
        this.dbManager = null;
    }

    async init(dbManager) {
        this.dbManager = dbManager;
        logger.info('QueueManager', 'QueueManager initialized with database');
    }

    async addToPendingQueue(track) {
        try {
            // Read-then-insert has to be one atomic unit: two concurrent requests
            // both read the same MAX and landed on the same queue_position.
            const nextPosition = await this.dbManager.withTransaction(async (tx) => {
                const positionSql = 'SELECT COALESCE(MAX(queue_position), 0) + 1 as next_position FROM song_queue FOR UPDATE';
                const positionResult = await tx.query(positionSql);
                const position = positionResult[0].next_position;

                const sql = `
                    INSERT INTO song_queue (track_uri, track_name, artist_name, requested_by, queue_position, added_at)
                    VALUES (?, ?, ?, ?, ?, NOW())
                `;
                await tx.query(sql, [
                    track.uri,
                    track.name,
                    track.artist,
                    track.requestedBy,
                    position
                ]);

                return position;
            });

            logger.debug('QueueManager', 'Track added to pending queue', {
                trackName: track.name,
                artist: track.artist,
                requestedBy: track.requestedBy,
                queuePosition: nextPosition
            });
        } catch (error) {
            logger.error('QueueManager', 'Error adding to pending queue', {
                error: error.message,
                stack: error.stack,
                trackName: track.name,
                artist: track.artist
            });
            throw error;
        }
    }

    async addToPriorityQueue(track) {
        try {
            await this.dbManager.withTransaction(async (tx) => {
                const incrementSql = 'UPDATE song_queue SET queue_position = queue_position + 1';
                await tx.query(incrementSql);

                const insertSql = `
                    INSERT INTO song_queue (track_uri, track_name, artist_name, requested_by, queue_position, added_at)
                    VALUES (?, ?, ?, ?, 1, NOW())
                `;
                await tx.query(insertSql, [
                    track.uri,
                    track.name,
                    track.artist,
                    track.requestedBy
                ]);
            });

            logger.debug('QueueManager', 'Track added to priority queue', {
                trackName: track.name,
                artist: track.artist,
                requestedBy: track.requestedBy,
                queuePosition: 1
            });
        } catch (error) {
            logger.error('QueueManager', 'Error adding to priority queue', {
                error: error.message,
                stack: error.stack,
                trackName: track.name,
                artist: track.artist
            });
            throw error;
        }
    }

    async clearQueue() {
        try {
            const sql = 'DELETE FROM song_queue';
            await this.dbManager.query(sql);
            logger.info('QueueManager', 'Queue cleared');
        } catch (error) {
            logger.error('QueueManager', 'Error clearing queue', {
                error: error.message,
                stack: error.stack
            });
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
            logger.debug('QueueManager', 'Retrieved pending tracks', {
                trackCount: results.length
            });
            return results;
        } catch (error) {
            logger.error('QueueManager', 'Error getting pending tracks', {
                error: error.message,
                stack: error.stack
            });
            return [];
        }
    }

    async removeFirstTrack() {
        try {
            await this.dbManager.withTransaction(async (tx) => {
                const deleteSql = 'DELETE FROM song_queue WHERE queue_position = 1';
                await tx.query(deleteSql);

                const updateSql = 'UPDATE song_queue SET queue_position = queue_position - 1';
                await tx.query(updateSql);
            });

            logger.debug('QueueManager', 'First track removed from queue');
        } catch (error) {
            logger.error('QueueManager', 'Error removing first track', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
}

module.exports = QueueManager;
