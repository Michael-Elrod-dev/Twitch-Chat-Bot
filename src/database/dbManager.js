const mysql = require('mysql2/promise');
const config = require('../config/config');
const logger = require('../logger/logger');

const DEFAULT_CONNECTION_LIMIT = 10;

class DbManager {
    constructor() {
        this.pool = null;
        logger.debug('DbManager', 'DbManager instance created');
    }

    async connect() {
        const connectionLimit = config.database.connectionLimit || DEFAULT_CONNECTION_LIMIT;

        try {
            logger.debug('DbManager', 'Attempting to connect to database', {
                host: config.database.host,
                database: config.database.database,
                connectionLimit
            });

            this.pool = mysql.createPool({
                ...config.database,
                waitForConnections: true,
                connectionLimit,
                queueLimit: 0
            });

            // createPool is lazy, so probe once to surface bad credentials or an
            // unreachable host here rather than on the first real query.
            const connection = await this.pool.getConnection();
            connection.release();

            logger.info('DbManager', 'Successfully connected to SQL database', {
                host: config.database.host,
                database: config.database.database,
                connectionLimit
            });
        } catch (error) {
            logger.error('DbManager', 'Failed to connect to database', {
                error: error.message,
                stack: error.stack,
                host: config.database.host,
                database: config.database.database
            });
            throw error;
        }
    }

    async query(sql, params = []) {
        try {
            const sqlPreview = sql.length > 100 ? sql.substring(0, 100) + '...' : sql;
            logger.debug('DbManager', 'Executing database query', {
                sqlPreview,
                paramCount: params.length
            });

            const results = await this.runOn(this.pool, sql, params);

            logger.debug('DbManager', 'Query executed successfully', {
                resultCount: Array.isArray(results) ? results.length : 'N/A',
                affectedRows: results.affectedRows,
                changedRows: results.changedRows
            });

            return results;
        } catch (error) {
            const sqlPreview = sql.length > 100 ? sql.substring(0, 100) + '...' : sql;
            logger.error('DbManager', 'Database query error', {
                error: error.message,
                stack: error.stack,
                sqlPreview,
                paramCount: params.length,
                code: error.code,
                errno: error.errno
            });
            throw error;
        }
    }

    /**
     * Runs a statement on a pool or a specific connection, returning just the rows
     * so both callers share one result shape.
     */
    async runOn(target, sql, params = []) {
        const [results] = params.length === 0
            ? await target.query(sql, params)
            : await target.execute(sql, params);

        return results;
    }

    /**
     * Runs `fn` inside a transaction on a dedicated connection: commits when it
     * resolves, rolls back and rethrows the original error when it throws, and
     * always releases the connection. Nesting is not supported - do not call
     * withTransaction from inside a withTransaction callback.
     */
    async withTransaction(fn) {
        if (!this.pool) {
            throw new Error('Cannot start transaction - database is not connected');
        }

        const connection = await this.pool.getConnection();

        try {
            await connection.beginTransaction();
            logger.debug('DbManager', 'Transaction started');

            const result = await fn({
                query: (sql, params = []) => this.runOn(connection, sql, params)
            });

            await connection.commit();
            logger.debug('DbManager', 'Transaction committed');

            return result;
        } catch (error) {
            logger.error('DbManager', 'Transaction failed, rolling back', {
                error: error.message,
                code: error.code,
                errno: error.errno
            });

            try {
                await connection.rollback();
                logger.debug('DbManager', 'Transaction rolled back');
            } catch (rollbackError) {
                logger.error('DbManager', 'Error rolling back transaction', {
                    error: rollbackError.message,
                    stack: rollbackError.stack
                });
            }

            throw error;
        } finally {
            connection.release();
            logger.debug('DbManager', 'Transaction connection released');
        }
    }

    async close() {
        if (this.pool) {
            logger.debug('DbManager', 'Closing database connection pool');
            await this.pool.end();
            this.pool = null;
            logger.info('DbManager', 'Database connection pool closed successfully');
        } else {
            logger.debug('DbManager', 'Close called but no active connection pool');
        }
    }
}

module.exports = DbManager;
