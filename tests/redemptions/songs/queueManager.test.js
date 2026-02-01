// tests/redemptions/songs/queueManager.test.js

const QueueManager = require('../../../src/redemptions/songs/queueManager');

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
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Delete failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            await expect(queueManager.clearQueue()).rejects.toThrow('Delete failed');
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
        });

        it('should return empty array when queue is empty', async () => {
            mockDbManager.query.mockResolvedValue([]);

            const result = await queueManager.getPendingTracks();

            expect(result).toEqual([]);
        });

        it('should return empty array on database error', async () => {
            const dbError = new Error('Query failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            const result = await queueManager.getPendingTracks();

            expect(result).toEqual([]);
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
        });
    });

    describe('Integration scenarios', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should handle complete queue lifecycle', async () => {
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

            mockDbManager.query.mockResolvedValueOnce([
                { uri: 'spotify:track:1', name: 'Song 1', artist: 'Artist 1', requestedBy: 'user1' },
                { uri: 'spotify:track:2', name: 'Song 2', artist: 'Artist 2', requestedBy: 'user2' }
            ]);

            const tracks = await queueManager.getPendingTracks();
            expect(tracks).toHaveLength(2);

            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });
            await queueManager.removeFirstTrack();

            expect(mockDbManager.query).toHaveBeenCalledWith(
                'DELETE FROM song_queue WHERE queue_position = 1'
            );
        });

        it('should handle priority and regular queue mix', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            await queueManager.addToPendingQueue({
                uri: 'spotify:track:1',
                name: 'Regular Song',
                artist: 'Artist',
                requestedBy: 'user1'
            });

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
