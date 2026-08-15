const QueueManager = require('../../../src/redemptions/songs/queueManager');
const { createMockDbManager } = require('../../__mocks__/mockDbManager');

describe('QueueManager', () => {
    let queueManager;
    let mockDbManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = createMockDbManager();

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

        it('should add track to end of queue inside a transaction', async () => {
            mockDbManager._transaction.query
                .mockResolvedValueOnce([{ next_position: 5 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            const track = {
                uri: 'spotify:track:123',
                name: 'Test Song',
                artist: 'Test Artist',
                requestedBy: 'testuser'
            };

            await queueManager.addToPendingQueue(track);

            // Read-then-insert has to be one atomic unit, or two concurrent
            // requests both read the same MAX and collide on queue_position.
            expect(mockDbManager.withTransaction).toHaveBeenCalledTimes(1);
            expect(mockDbManager.query).not.toHaveBeenCalled();

            expect(mockDbManager._transaction.query).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('COALESCE(MAX(queue_position), 0) + 1')
            );

            expect(mockDbManager._transaction.query).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('INSERT INTO song_queue'),
                ['spotify:track:123', 'Test Song', 'Test Artist', 'testuser', 5]
            );
        });

        it('should add first track at position 1', async () => {
            mockDbManager._transaction.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            const track = {
                uri: 'spotify:track:123',
                name: 'First Song',
                artist: 'Artist',
                requestedBy: 'user1'
            };

            await queueManager.addToPendingQueue(track);

            expect(mockDbManager._transaction.query).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.arrayContaining([expect.anything(), expect.anything(), expect.anything(), expect.anything(), 1])
            );
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Database error');
            dbError.stack = 'Error stack';
            mockDbManager._transaction.query.mockRejectedValue(dbError);

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

        it('should add track to front of queue inside a transaction', async () => {
            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await queueManager.addToPriorityQueue(track);

            expect(mockDbManager.withTransaction).toHaveBeenCalledTimes(1);

            // Both statements run on the transaction's connection, not the pool.
            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position + 1'
            );
            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO song_queue'),
                ['spotify:track:456', 'Priority Song', 'Priority Artist', 'vipuser']
            );
            expect(mockDbManager.query).not.toHaveBeenCalled();

            expect(mockDbManager._transaction.commit).toHaveBeenCalled();
            expect(mockDbManager._transaction.rollback).not.toHaveBeenCalled();
        });

        it('should roll back and leave the queue untouched when the insert fails', async () => {
            const dbError = new Error('Insert failed');
            dbError.stack = 'Error stack';

            mockDbManager._transaction.query
                .mockResolvedValueOnce({ affectedRows: 2 }) // UPDATE shifts positions
                .mockRejectedValueOnce(dbError);            // INSERT fails

            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await expect(queueManager.addToPriorityQueue(track)).rejects.toThrow('Insert failed');

            // The position shift must not survive the failed insert.
            expect(mockDbManager._transaction.rollback).toHaveBeenCalled();
            expect(mockDbManager._transaction.commit).not.toHaveBeenCalled();
        });

        it('should surface the original error when the transaction fails', async () => {
            const txError = new Error('Deadlock found when trying to get lock');
            mockDbManager.withTransaction.mockRejectedValue(txError);

            const track = {
                uri: 'spotify:track:456',
                name: 'Priority Song',
                artist: 'Priority Artist',
                requestedBy: 'vipuser'
            };

            await expect(queueManager.addToPriorityQueue(track)).rejects.toBe(txError);
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

            expect(mockDbManager.withTransaction).toHaveBeenCalledTimes(1);
            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                'DELETE FROM song_queue WHERE queue_position = 1'
            );
            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position - 1'
            );
            expect(mockDbManager.query).not.toHaveBeenCalled();
            expect(mockDbManager._transaction.commit).toHaveBeenCalled();
        });

        it('should roll back so the pop and the reorder cannot half-apply', async () => {
            const deleteError = new Error('Delete failed');
            deleteError.stack = 'Error stack';

            mockDbManager._transaction.query.mockRejectedValueOnce(deleteError);

            await expect(queueManager.removeFirstTrack()).rejects.toThrow('Delete failed');

            expect(mockDbManager._transaction.rollback).toHaveBeenCalled();
            expect(mockDbManager._transaction.commit).not.toHaveBeenCalled();
        });
    });

    describe('Integration scenarios', () => {
        beforeEach(async () => {
            await queueManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should handle complete queue lifecycle', async () => {
            mockDbManager._transaction.query
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

            await queueManager.removeFirstTrack();

            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                'DELETE FROM song_queue WHERE queue_position = 1'
            );
            expect(mockDbManager._transaction.commit).toHaveBeenCalled();
        });

        it('should handle priority and regular queue mix', async () => {
            mockDbManager._transaction.query
                .mockResolvedValueOnce([{ next_position: 1 }])
                .mockResolvedValueOnce({ affectedRows: 1 });

            await queueManager.addToPendingQueue({
                uri: 'spotify:track:1',
                name: 'Regular Song',
                artist: 'Artist',
                requestedBy: 'user1'
            });

            await queueManager.addToPriorityQueue({
                uri: 'spotify:track:2',
                name: 'Priority Song',
                artist: 'Artist',
                requestedBy: 'vipuser'
            });

            expect(mockDbManager._transaction.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = queue_position + 1'
            );
            expect(mockDbManager._transaction.commit).toHaveBeenCalled();
        });
    });
});
