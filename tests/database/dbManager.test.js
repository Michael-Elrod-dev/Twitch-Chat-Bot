const DbManager = require('../../src/database/dbManager');

jest.mock('mysql2/promise', () => ({
    createPool: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    database: {
        host: 'localhost',
        user: 'testuser',
        password: 'testpass',
        database: 'testdb',
        connectionLimit: 7
    }
}));

const mysql = require('mysql2/promise');

describe('DbManager', () => {
    let dbManager;
    let mockPool;
    let mockConnection;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnection = {
            query: jest.fn().mockResolvedValue([[], []]),
            execute: jest.fn().mockResolvedValue([[], []]),
            beginTransaction: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue(undefined),
            rollback: jest.fn().mockResolvedValue(undefined),
            release: jest.fn()
        };

        mockPool = {
            query: jest.fn(),
            execute: jest.fn(),
            getConnection: jest.fn().mockResolvedValue(mockConnection),
            end: jest.fn().mockResolvedValue(undefined)
        };

        mysql.createPool.mockReturnValue(mockPool);

        dbManager = new DbManager();
    });

    describe('constructor', () => {
        it('should initialize with no pool', () => {
            expect(dbManager.pool).toBeNull();
        });
    });

    describe('connect', () => {
        it('should create a pool with the configured values', async () => {
            await dbManager.connect();

            expect(mysql.createPool).toHaveBeenCalledWith({
                host: 'localhost',
                user: 'testuser',
                password: 'testpass',
                database: 'testdb',
                waitForConnections: true,
                connectionLimit: 7,
                queueLimit: 0
            });
            expect(dbManager.pool).toBe(mockPool);
        });

        it('should default the connection limit to 10 when unset', async () => {
            const config = require('../../src/config/config');
            const original = config.database.connectionLimit;
            delete config.database.connectionLimit;

            await dbManager.connect();

            expect(mysql.createPool).toHaveBeenCalledWith(
                expect.objectContaining({ connectionLimit: 10 })
            );

            config.database.connectionLimit = original;
        });

        it('should probe the pool so bad credentials fail at connect time', async () => {
            await dbManager.connect();

            expect(mockPool.getConnection).toHaveBeenCalled();
            expect(mockConnection.release).toHaveBeenCalled();
        });

        it('should throw when the probe cannot get a connection', async () => {
            const connectionError = new Error('Access denied');
            connectionError.stack = 'Error stack trace';
            mockPool.getConnection.mockRejectedValue(connectionError);

            await expect(dbManager.connect()).rejects.toThrow('Access denied');
        });

        it('should handle network timeout errors', async () => {
            const timeoutError = new Error('ETIMEDOUT');
            timeoutError.code = 'ETIMEDOUT';
            mockPool.getConnection.mockRejectedValue(timeoutError);

            await expect(dbManager.connect()).rejects.toThrow('ETIMEDOUT');
        });
    });

    describe('query', () => {
        beforeEach(async () => {
            await dbManager.connect();
            jest.clearAllMocks();
        });

        it('should execute a parameterized query on the pool', async () => {
            const mockResults = [{ id: 1, name: 'test' }];
            mockPool.execute.mockResolvedValue([mockResults, []]);

            const sql = 'SELECT * FROM users WHERE id = ?';
            const results = await dbManager.query(sql, [1]);

            expect(mockPool.execute).toHaveBeenCalledWith(sql, [1]);
            expect(results).toEqual(mockResults);
        });

        it('should use query() when the params array is empty', async () => {
            const mockResults = [{ count: 5 }];
            mockPool.query.mockResolvedValue([mockResults, []]);

            const sql = 'SELECT COUNT(*) as count FROM users';
            const results = await dbManager.query(sql, []);

            expect(mockPool.query).toHaveBeenCalledWith(sql, []);
            expect(mockPool.execute).not.toHaveBeenCalled();
            expect(results).toEqual(mockResults);
        });

        it('should default params to an empty array', async () => {
            mockPool.query.mockResolvedValue([[], []]);

            await dbManager.query('SELECT 1');

            expect(mockPool.query).toHaveBeenCalledWith('SELECT 1', []);
        });

        it('should return write results unwrapped', async () => {
            const writeResult = { affectedRows: 3, changedRows: 2 };
            mockPool.execute.mockResolvedValue([writeResult, []]);

            const results = await dbManager.query('UPDATE users SET x = ?', [1]);

            expect(results).toEqual(writeResult);
        });

        it('should throw on query failure', async () => {
            const queryError = new Error('Syntax error');
            queryError.code = 'ER_PARSE_ERROR';
            queryError.errno = 1064;
            queryError.stack = 'Error stack';
            mockPool.execute.mockRejectedValue(queryError);

            await expect(dbManager.query('INVALID SQL', [1])).rejects.toThrow('Syntax error');
        });

        it('should handle duplicate key errors', async () => {
            const duplicateError = new Error('Duplicate entry');
            duplicateError.code = 'ER_DUP_ENTRY';
            duplicateError.errno = 1062;
            mockPool.execute.mockRejectedValue(duplicateError);

            await expect(
                dbManager.query('INSERT INTO users VALUES (?)', ['test'])
            ).rejects.toThrow('Duplicate entry');
        });

        it('should handle connection lost errors', async () => {
            const connectionError = new Error('Connection lost');
            connectionError.code = 'PROTOCOL_CONNECTION_LOST';
            connectionError.stack = 'Error stack';
            mockPool.execute.mockRejectedValue(connectionError);

            await expect(
                dbManager.query('SELECT * FROM users WHERE id = ?', [1])
            ).rejects.toThrow('Connection lost');
        });

        it('should not hold a pooled connection across calls', async () => {
            mockPool.query.mockResolvedValue([[], []]);

            await dbManager.query('SELECT 1');
            await dbManager.query('SELECT 2');

            // Pool passthrough - queries must never check out a dedicated connection.
            expect(mockPool.getConnection).not.toHaveBeenCalled();
        });
    });

    describe('withTransaction', () => {
        beforeEach(async () => {
            await dbManager.connect();
            jest.clearAllMocks();
        });

        it('should reject when the database is not connected', async () => {
            const disconnected = new DbManager();

            await expect(disconnected.withTransaction(async () => {}))
                .rejects.toThrow('Cannot start transaction - database is not connected');
        });

        it('should run the callback on a dedicated connection', async () => {
            await dbManager.withTransaction(async (tx) => {
                await tx.query('UPDATE song_queue SET queue_position = 1');
            });

            expect(mockPool.getConnection).toHaveBeenCalledTimes(1);
            expect(mockConnection.query).toHaveBeenCalledWith(
                'UPDATE song_queue SET queue_position = 1',
                []
            );
        });

        it('should use execute for parameterized statements inside the transaction', async () => {
            await dbManager.withTransaction(async (tx) => {
                await tx.query('INSERT INTO song_queue VALUES (?)', ['uri']);
            });

            expect(mockConnection.execute).toHaveBeenCalledWith(
                'INSERT INTO song_queue VALUES (?)',
                ['uri']
            );
        });

        it('should unwrap rows for the callback', async () => {
            mockConnection.execute.mockResolvedValue([[{ id: 7 }], []]);

            let seen;
            await dbManager.withTransaction(async (tx) => {
                seen = await tx.query('SELECT * FROM song_queue WHERE id = ?', [7]);
            });

            expect(seen).toEqual([{ id: 7 }]);
        });

        it('should begin then commit on success', async () => {
            await dbManager.withTransaction(async () => 'done');

            expect(mockConnection.beginTransaction).toHaveBeenCalled();
            expect(mockConnection.commit).toHaveBeenCalled();
            expect(mockConnection.rollback).not.toHaveBeenCalled();
            expect(mockConnection.beginTransaction.mock.invocationCallOrder[0])
                .toBeLessThan(mockConnection.commit.mock.invocationCallOrder[0]);
        });

        it('should return the callback result', async () => {
            const result = await dbManager.withTransaction(async () => ({ ok: true }));

            expect(result).toEqual({ ok: true });
        });

        it('should release the connection on success', async () => {
            await dbManager.withTransaction(async () => {});

            expect(mockConnection.release).toHaveBeenCalledTimes(1);
        });

        it('should roll back and rethrow the original error when the callback throws', async () => {
            const failure = new Error('Constraint violated');

            await expect(
                dbManager.withTransaction(async () => {
                    throw failure;
                })
            ).rejects.toBe(failure);

            expect(mockConnection.rollback).toHaveBeenCalled();
            expect(mockConnection.commit).not.toHaveBeenCalled();
        });

        it('should release the connection when the callback throws', async () => {
            await expect(
                dbManager.withTransaction(async () => {
                    throw new Error('boom');
                })
            ).rejects.toThrow('boom');

            expect(mockConnection.release).toHaveBeenCalledTimes(1);
        });

        it('should roll back when a statement inside the transaction fails', async () => {
            mockConnection.execute.mockRejectedValue(new Error('Deadlock'));

            await expect(
                dbManager.withTransaction(async (tx) => {
                    await tx.query('INSERT INTO song_queue VALUES (?)', ['uri']);
                })
            ).rejects.toThrow('Deadlock');

            expect(mockConnection.rollback).toHaveBeenCalled();
            expect(mockConnection.release).toHaveBeenCalled();
        });

        it('should rethrow the original error even if the rollback itself fails', async () => {
            const failure = new Error('Original failure');
            mockConnection.rollback.mockRejectedValue(new Error('Rollback failed'));

            await expect(
                dbManager.withTransaction(async () => {
                    throw failure;
                })
            ).rejects.toBe(failure);
        });

        it('should still release the connection when the rollback fails', async () => {
            mockConnection.rollback.mockRejectedValue(new Error('Rollback failed'));

            await expect(
                dbManager.withTransaction(async () => {
                    throw new Error('boom');
                })
            ).rejects.toThrow('boom');

            expect(mockConnection.release).toHaveBeenCalledTimes(1);
        });

        it('should propagate a failure to begin the transaction and release', async () => {
            mockConnection.beginTransaction.mockRejectedValue(new Error('Cannot begin'));

            await expect(dbManager.withTransaction(async () => {}))
                .rejects.toThrow('Cannot begin');

            expect(mockConnection.release).toHaveBeenCalledTimes(1);
        });

        it('should use a separate connection per transaction', async () => {
            await dbManager.withTransaction(async () => {});
            await dbManager.withTransaction(async () => {});

            expect(mockPool.getConnection).toHaveBeenCalledTimes(2);
            expect(mockConnection.release).toHaveBeenCalledTimes(2);
        });
    });

    describe('close', () => {
        it('should end the pool', async () => {
            await dbManager.connect();
            jest.clearAllMocks();

            await dbManager.close();

            expect(mockPool.end).toHaveBeenCalled();
            expect(dbManager.pool).toBeNull();
        });

        it('should handle close when there is no pool', async () => {
            await expect(dbManager.close()).resolves.toBeUndefined();
        });

        it('should propagate an error if pool.end() fails', async () => {
            await dbManager.connect();
            mockPool.end.mockRejectedValue(new Error('Already closed'));

            await expect(dbManager.close()).rejects.toThrow('Already closed');
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete lifecycle: connect, query, close', async () => {
            mockPool.execute.mockResolvedValue([[{ id: 1 }], []]);

            await dbManager.connect();
            const results = await dbManager.query('SELECT * FROM users WHERE id = ?', [1]);
            await dbManager.close();

            expect(results).toEqual([{ id: 1 }]);
            expect(dbManager.pool).toBeNull();
        });

        it('should handle multiple queries in sequence', async () => {
            mockPool.execute
                .mockResolvedValueOnce([[{ id: 1 }], []])
                .mockResolvedValueOnce([[{ id: 2 }], []])
                .mockResolvedValueOnce([[{ id: 3 }], []]);

            await dbManager.connect();

            const result1 = await dbManager.query('SELECT * FROM users WHERE id = ?', [1]);
            const result2 = await dbManager.query('SELECT * FROM users WHERE id = ?', [2]);
            const result3 = await dbManager.query('SELECT * FROM users WHERE id = ?', [3]);

            expect(result1).toEqual([{ id: 1 }]);
            expect(result2).toEqual([{ id: 2 }]);
            expect(result3).toEqual([{ id: 3 }]);
        });

        it('should keep pool queries independent of an in-flight transaction', async () => {
            mockPool.query.mockResolvedValue([[{ id: 99 }], []]);

            await dbManager.connect();

            const seen = await dbManager.withTransaction(async () => {
                // A concurrent analytics write lands mid-transaction. It must go to
                // the pool, not the transaction's connection - the P0-3 failure was
                // exactly this interleaving on one shared connection.
                return dbManager.query('SELECT * FROM chat_messages');
            });

            expect(seen).toEqual([{ id: 99 }]);
            expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM chat_messages', []);
            expect(mockConnection.query).not.toHaveBeenCalledWith('SELECT * FROM chat_messages', []);
            expect(mockConnection.commit).toHaveBeenCalled();
        });
    });
});
