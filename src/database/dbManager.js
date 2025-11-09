// src/database/dbManager.js

const mysql = require('mysql2/promise');
const config = require('../config/config');
const logger = require('../logger/logger');

class DbManager {
    constructor() {
        this.connection = null;
        logger.debug('DbManager', 'DbManager instance created');
    }

    async connect() {
        try {
            logger.debug('DbManager', 'Attempting to connect to database', {
                host: config.database.host,
                database: config.database.database
            });

            this.connection = await mysql.createConnection(config.database);

            logger.info('DbManager', 'Successfully connected to SQL database', {
                host: config.database.host,
                database: config.database.database
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
            const transactionCommands = ['START TRANSACTION', 'COMMIT', 'ROLLBACK'];
            const isTransactionCommand = transactionCommands.some(cmd =>
                sql.trim().toUpperCase().startsWith(cmd)
            );

            const sqlPreview = sql.length > 100 ? sql.substring(0, 100) + '...' : sql;
            logger.debug('DbManager', 'Executing database query', {
                sqlPreview,
                paramCount: params.length,
                isTransactionCommand
            });

            let results;
            if (isTransactionCommand || params.length === 0) {
                [results] = await this.connection.query(sql, params);
            } else {
                [results] = await this.connection.execute(sql, params);
            }

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

    async close() {
        if (this.connection) {
            logger.debug('DbManager', 'Closing database connection');
            await this.connection.end();
            this.connection = null;
            logger.info('DbManager', 'Database connection closed successfully');
        } else {
            logger.debug('DbManager', 'Close called but no active connection');
        }
    }
}

module.exports = DbManager;
