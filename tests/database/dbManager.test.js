// tests/database/dbManager.test.js

const DbManager = require('../../src/database/dbManager');

jest.mock('mysql2/promise', () => ({
    createConnection: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    database: {
        host: 'localhost',
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    }
}));

const mysql = require('mysql2/promise');

describe('DbManager', () => {
    let dbManager;
    let mockConnection;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnection = {
            query: jest.fn(),
            execute: jest.fn(),
            end: jest.fn()
        };

        dbManager = new DbManager();
    });

    describe('constructor', () => {
        it('should initialize with null connection', () => {
            expect(dbManager.connection).toBeNull();
        });
    });

    describe('connect', () => {
        it('should successfully connect to database', async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);

            await dbManager.connect();

            expect(mysql.createConnection).toHaveBeenCalledWith({
                host: 'localhost',
                user: 'testuser',
                password: 'testpass',
                database: 'testdb'
            });
            expect(dbManager.connection).toBe(mockConnection);
        });

        it('should throw error on connection failure', async () => {
            const connectionError = new Error('Connection refused');
            connectionError.stack = 'Error stack trace';
            mysql.createConnection.mockRejectedValue(connectionError);

            await expect(dbManager.connect()).rejects.toThrow('Connection refused');
        });

        it('should handle network timeout errors', async () => {
            const timeoutError = new Error('ETIMEDOUT');
            timeoutError.code = 'ETIMEDOUT';
            mysql.createConnection.mockRejectedValue(timeoutError);

            await expect(dbManager.connect()).rejects.toThrow('ETIMEDOUT');
        });
    });

    describe('query', () => {
        beforeEach(async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);
            await dbManager.connect();
            jest.clearAllMocks();
        });

        it('should execute parameterized query successfully', async () => {
            const mockResults = [{ id: 1, name: 'test' }];
            mockConnection.execute.mockResolvedValue([mockResults, []]);

            const sql = 'SELECT * FROM users WHERE id = ?';
            const params = [1];
            const results = await dbManager.query(sql, params);

            expect(mockConnection.execute).toHaveBeenCalledWith(sql, params);
            expect(results).toEqual(mockResults);
        });

        it('should use query() for transaction commands', async () => {
            const mockResults = { affectedRows: 0 };
            mockConnection.query.mockResolvedValue([mockResults, []]);

            const sql = 'START TRANSACTION';
            const results = await dbManager.query(sql, []);

            expect(mockConnection.query).toHaveBeenCalledWith(sql, []);
            expect(mockConnection.execute).not.toHaveBeenCalled();
            expect(results).toEqual(mockResults);
        });

        it('should handle COMMIT transaction command', async () => {
            const mockResults = { affectedRows: 0 };
            mockConnection.query.mockResolvedValue([mockResults, []]);

            const results = await dbManager.query('COMMIT', []);

            expect(mockConnection.query).toHaveBeenCalledWith('COMMIT', []);
            expect(results).toEqual(mockResults);
        });

        it('should handle ROLLBACK transaction command', async () => {
            const mockResults = { affectedRows: 0 };
            mockConnection.query.mockResolvedValue([mockResults, []]);

            const results = await dbManager.query('ROLLBACK', []);

            expect(mockConnection.query).toHaveBeenCalledWith('ROLLBACK', []);
            expect(results).toEqual(mockResults);
        });

        it('should use query() when params array is empty', async () => {
            const mockResults = [{ count: 5 }];
            mockConnection.query.mockResolvedValue([mockResults, []]);

            const sql = 'SELECT COUNT(*) as count FROM users';
            const results = await dbManager.query(sql, []);

            expect(mockConnection.query).toHaveBeenCalledWith(sql, []);
            expect(results).toEqual(mockResults);
        });

        it('should throw error on query failure', async () => {
            const queryError = new Error('Syntax error');
            queryError.code = 'ER_PARSE_ERROR';
            queryError.errno = 1064;
            queryError.stack = 'Error stack';
            mockConnection.execute.mockRejectedValue(queryError);

            const sql = 'INVALID SQL';
            const params = [1];

            await expect(dbManager.query(sql, params)).rejects.toThrow('Syntax error');
        });

        it('should handle duplicate key errors', async () => {
            const duplicateError = new Error('Duplicate entry');
            duplicateError.code = 'ER_DUP_ENTRY';
            duplicateError.errno = 1062;
            mockConnection.execute.mockRejectedValue(duplicateError);

            await expect(
                dbManager.query('INSERT INTO users VALUES (?)', ['test'])
            ).rejects.toThrow('Duplicate entry');
        });

        it('should handle connection lost errors', async () => {
            const connectionError = new Error('Connection lost');
            connectionError.code = 'PROTOCOL_CONNECTION_LOST';
            connectionError.stack = 'Error stack';
            mockConnection.execute.mockRejectedValue(connectionError);

            await expect(
                dbManager.query('SELECT * FROM users', [1])
            ).rejects.toThrow('Connection lost');
        });
    });

    describe('close', () => {
        it('should close active connection', async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);
            await dbManager.connect();
            jest.clearAllMocks();

            await dbManager.close();

            expect(mockConnection.end).toHaveBeenCalled();
            expect(dbManager.connection).toBeNull();
        });

        it('should handle close when no active connection', async () => {
            await dbManager.close();
        });

        it('should not throw error if connection.end() fails', async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);
            await dbManager.connect();
            mockConnection.end.mockRejectedValue(new Error('Already closed'));

            await expect(dbManager.close()).rejects.toThrow('Already closed');
        });
    });

    describe('Integration scenarios', () => {
        it('should handle complete lifecycle: connect, query, close', async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);
            mockConnection.execute.mockResolvedValue([[{ id: 1 }], []]);

            await dbManager.connect();
            const results = await dbManager.query('SELECT * FROM users WHERE id = ?', [1]);
            await dbManager.close();

            expect(results).toEqual([{ id: 1 }]);
            expect(dbManager.connection).toBeNull();
        });

        it('should handle multiple queries in sequence', async () => {
            mysql.createConnection.mockResolvedValue(mockConnection);
            mockConnection.execute
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
    });
});
