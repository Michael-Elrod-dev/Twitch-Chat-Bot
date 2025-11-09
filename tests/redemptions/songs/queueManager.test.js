// tests/redemptions/songs/queueManager.test.js

const QueueManager = require('../../../src/redemptions/songs/queueManager');

// Mock logger
jest.mock('../../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../../../src/logger/logger');

describe('QueueManager', () => {
    let queueManager;
    let mockDbManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = {
            query: jest.fn()
        };

        queueManager = new QueueManager();
    });

    describe('constructor', () => {
        it('should initialize with null dbManager', () => {
            expect(queueManager.dbManager).toBeNull();
        });
    });

    describe('init', () => {
        it('should initialize with database manager', async () => {
            await queueManager.init(mockDbManager);

            expect(queueManager.dbManager).toBe(mockDbManager);
            expect(logger.info).toHaveBeenCalledWith(
                'QueueManager',
                'QueueManager initialized with database'
            );
        });
    });

    describe('addToPendingQueue', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should add track to end of queue', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([{ next_position: 5 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            const track = {
                uri: 'spotify:track:123',
                name: 'Test Song',
                artist: 'Test Artist',
                requestedBy: 'testuser'
            };

            await queueManager.addToPendingQueue(track);

            expect(mockDbManager.query).toHaveBeenNthCalledWith(
                1,
                'SELECT COALESCE(MAX(queue_position), 0) + 1 as next_position FROM song_queue'
            );

            expect(mockDbManager.query).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('INSERT INTO song_queue'),
                ['spotify:track:123', 'Test Song', 'Test Artist', 'testuser', 5]
            );

            expect(logger.debug).toHaveBeenCalledWith(
                'QueueManager',
                'Track added to pending queue',
                expect.objectContaining({
                    trackName: 'Test Song',
                    artist: 'Test Artist',
                    requestedBy: 'testuser',
                    queuePosition: 5
                })
            );
        });

        it('should add first track at position 1', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            const track = {
                uri: 'spotify:track:123',
                name: 'First Song',
                artist: 'Artist',
                requestedBy: 'user1'
            };

            await queueManager.addToPendingQueue(track);

            expect(mockDbManager.query).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.arrayContaining([expect.anything(), expect.anything(), expect.anything(), expect.anything(), 1])
            );
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Database error');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            const track = {
                uri: 'spotify:track:123',
                name: 'Test Song',
                artist: 'Test Artist',
                requestedBy: 'testuser'
            };

            await expect(queueManager.addToPendingQueue(track)).rejects.toThrow('Database error');

            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error adding to pending queue',
                expect.objectContaining({
                    error: 'Database error',
                    trackName: 'Test Song',
                    artist: 'Test Artist'
                })
            );
        });
    });

    describe('addToPriorityQueue', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should add track to front of queue with transaction', async () => {
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });

            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await queueManager.addToPriorityQueue(track);

            expect(mockDbManager.query).toHaveBeenCalledWith('START TRANSACTION');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position + 1'
            );
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO song_queue'),
                ['spotify:track:456', 'Priority Song', 'Priority Artist', 'vipuser']
            );
            expect(mockDbManager.query).toHaveBeenCalledWith('COMMIT');

            expect(logger.debug).toHaveBeenCalledWith(
                'QueueManager',
                'Track added to priority queue',
                expect.objectContaining({
                    trackName: 'Priority Song',
                    artist: 'Priority Artist',
                    requestedBy: 'vipuser',
                    queuePosition: 1
                })
            );
        });

        it('should rollback transaction on error', async () => {
            const dbError = new Error('Insert failed');
            dbError.stack = 'Error stack';

            mockDbManager.query
                .mockResolvedValueOnce({ affectedRows: 1 }) // START TRANSACTION
                .mockResolvedValueOnce({ affectedRows: 2 }) // UPDATE
                .mockRejectedValueOnce(dbError)             // INSERT fails
                .mockResolvedValueOnce({ affectedRows: 0 }); // ROLLBACK

            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await expect(queueManager.addToPriorityQueue(track)).rejects.toThrow('Insert failed');

            expect(mockDbManager.query).toHaveBeenCalledWith('ROLLBACK');
            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error adding to priority queue',
                expect.objectContaining({
                    error: 'Insert failed',
                    trackName: 'Priority Song',
                    artist: 'Priority Artist'
                })
            );
        });

        it('should handle rollback failure', async () => {
            const insertError = new Error('Insert failed');
            const rollbackError = new Error('Rollback failed');
            insertError.stack = 'Error stack';
            rollbackError.stack = 'Rollback stack';

            mockDbManager.query
                .mockResolvedValueOnce({ affectedRows: 1 }) // START TRANSACTION
                .mockResolvedValueOnce({ affectedRows: 2 }) // UPDATE
                .mockRejectedValueOnce(insertError)         // INSERT fails
                .mockRejectedValueOnce(rollbackError);      // ROLLBACK fails

            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await expect(queueManager.addToPriorityQueue(track)).rejects.toThrow('Insert failed');

            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error rolling back transaction',
                expect.objectContaining({
                    error: 'Rollback failed'
                })
            );
        });
    });

    describe('clearQueue', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should delete all tracks from queue', async () => {
            mockDbManager.query.mockResolvedValue({ affectedRows: 5 });

            await queueManager.clearQueue();

            expect(mockDbManager.query).toHaveBeenCalledWith('DELETE FROM song_queue');
            expect(logger.info).toHaveBeenCalledWith('QueueManager', 'Queue cleared');
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Delete failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            await expect(queueManager.clearQueue()).rejects.toThrow('Delete failed');

            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error clearing queue',
                expect.objectContaining({
                    error: 'Delete failed'
                })
            );
        });
    });

    describe('getPendingTracks', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should retrieve all pending tracks in order', async () => {
            const mockTracks = [
                {
                    uri: 'spotify:track:1',
                    name: 'Song 1',
                    artist: 'Artist 1',
                    requestedBy: 'user1',
                    addedAt: new Date()
                },
                {
                    uri: 'spotify:track:2',
                    name: 'Song 2',
                    artist: 'Artist 2',
                    requestedBy: 'user2',
                    addedAt: new Date()
                }
            ];

            mockDbManager.query.mockResolvedValue(mockTracks);

            const result = await queueManager.getPendingTracks();

            expect(result).toEqual(mockTracks);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('ORDER BY queue_position ASC')
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'QueueManager',
                'Retrieved pending tracks',
                expect.objectContaining({ trackCount: 2 })
            );
        });

        it('should return empty array when queue is empty', async () => {
            mockDbManager.query.mockResolvedValue([]);

            const result = await queueManager.getPendingTracks();

            expect(result).toEqual([]);
            expect(logger.debug).toHaveBeenCalledWith(
                'QueueManager',
                'Retrieved pending tracks',
                expect.objectContaining({ trackCount: 0 })
            );
        });

        it('should return empty array on database error', async () => {
            const dbError = new Error('Query failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            const result = await queueManager.getPendingTracks();

            expect(result).toEqual([]);
            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error getting pending tracks',
                expect.objectContaining({
                    error: 'Query failed'
                })
            );
        });
    });

    describe('removeFirstTrack', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should remove first track and reorder queue', async () => {
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });

            await queueManager.removeFirstTrack();

            expect(mockDbManager.query).toHaveBeenCalledWith('START TRANSACTION');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                'DELETE FROM song_queue WHERE queue_position = 1'
            );
            expect(mockDbManager.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position - 1'
            );
            expect(mockDbManager.query).toHaveBeenCalledWith('COMMIT');
            expect(logger.debug).toHaveBeenCalledWith(
                'QueueManager',
                'First track removed from queue'
            );
        });

        it('should rollback on error', async () => {
            const deleteError = new Error('Delete failed');
            deleteError.stack = 'Error stack';

            mockDbManager.query
                .mockResolvedValueOnce({ affectedRows: 1 }) // START TRANSACTION
                .mockRejectedValueOnce(deleteError)         // DELETE fails
                .mockResolvedValueOnce({ affectedRows: 0 }); // ROLLBACK

            await expect(queueManager.removeFirstTrack()).rejects.toThrow('Delete failed');

            expect(mockDbManager.query).toHaveBeenCalledWith('ROLLBACK');
            expect(logger.error).toHaveBeenCalledWith(
                'QueueManager',
                'Error removing first track',
                expect.objectContaining({
                    error: 'Delete failed'
                })
            );
        });
    });

    describe('Integration scenarios', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should handle complete queue lifecycle', async () => {
            // Add tracks
            mockDbManager.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 })
                .mockResolvedValueOnce([{ next_position: 2 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            await queueManager.addToPendingQueue({
                uri: 'spotify:track:1',
                name: 'Song 1',
                artist: 'Artist 1',
                requestedBy: 'user1'
            });

            await queueManager.addToPendingQueue({
                uri: 'spotify:track:2',
                name: 'Song 2',
                artist: 'Artist 2',
                requestedBy: 'user2'
            });

            // Get tracks
            mockDbManager.query.mockResolvedValueOnce([
                { uri: 'spotify:track:1', name: 'Song 1', artist: 'Artist 1', requestedBy: 'user1' },
                { uri: 'spotify:track:2', name: 'Song 2', artist: 'Artist 2', requestedBy: 'user2' }
            ]);

            const tracks = await queueManager.getPendingTracks();
            expect(tracks).toHaveLength(2);

            // Remove first track
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });
            await queueManager.removeFirstTrack();

            expect(mockDbManager.query).toHaveBeenCalledWith(
                'DELETE FROM song_queue WHERE queue_position = 1'
            );
        });

        it('should handle priority and regular queue mix', async () => {
            // Add regular track
            mockDbManager.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            await queueManager.addToPendingQueue({
                uri: 'spotify:track:1',
                name: 'Regular Song',
                artist: 'Artist',
                requestedBy: 'user1'
            });

            // Add priority track
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });

            await queueManager.addToPriorityQueue({
                uri: 'spotify:track:2',
                name: 'Priority Song',
                artist: 'Artist',
                requestedBy: 'vipuser'
            });

            expect(mockDbManager.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position + 1'
            );
        });
    });
});
