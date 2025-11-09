// src/database/debugDbSetup.js

const mysql = require('mysql2/promise');
const config = require('../config/config');
const logger = require('../logger/logger');

class DebugDbSetup {
    constructor() {
        this.productionDbName = process.env.DB_NAME;
        this.debugDbName = process.env.DB_NAME + '_debug';
    }

    /**
     * Setup debug database - drop if exists, create new, copy schema and data
     */
    async setupDebugDatabase() {
        let connection = null;

        try {
            logger.info('DebugDbSetup', '=== Setting up debug database ===');

            // Connect without specifying a database (so we can create/drop databases)
            connection = await mysql.createConnection({
                host: config.database.host,
                port: config.database.port,
                user: config.database.user,
                password: config.database.password
            });

            logger.info('DebugDbSetup', 'Connected to MySQL server');

            // Step 1: Drop debug database if it exists
            logger.info('DebugDbSetup', 'Checking for existing debug database', { debugDbName: this.debugDbName });
            await connection.query(`DROP DATABASE IF EXISTS \`${this.debugDbName}\``);
            logger.info('DebugDbSetup', 'Dropped existing debug database (if any)');

            // Step 2: Create fresh debug database
            logger.info('DebugDbSetup', 'Creating new debug database', { debugDbName: this.debugDbName });
            await connection.query(`CREATE DATABASE \`${this.debugDbName}\``);
            logger.info('DebugDbSetup', 'Debug database created successfully');

            // Step 3: Copy schema structure from production
            logger.info('DebugDbSetup', 'Copying schema from production', {
                productionDb: this.productionDbName,
                debugDb: this.debugDbName
            });

            // Disable foreign key checks to avoid constraint issues during copy
            await connection.query('SET FOREIGN_KEY_CHECKS = 0');
            logger.debug('DebugDbSetup', 'Disabled foreign key checks');

            // Get list of all tables in production
            const [tables] = await connection.query(
                'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?',
                [this.productionDbName]
            );

            logger.info('DebugDbSetup', 'Found tables to copy', { tableCount: tables.length });

            // First pass: Create all table structures
            logger.debug('DebugDbSetup', 'Creating table structures...');
            for (const tableRow of tables) {
                const tableName = tableRow.TABLE_NAME;

                try {
                    // Get CREATE TABLE statement
                    const [createTableResult] = await connection.query(
                        `SHOW CREATE TABLE \`${this.productionDbName}\`.\`${tableName}\``
                    );

                    let createTableSql = createTableResult[0]['Create Table'];

                    // Replace table name to include debug database
                    createTableSql = createTableSql.replace(
                        `CREATE TABLE \`${tableName}\``,
                        `CREATE TABLE \`${this.debugDbName}\`.\`${tableName}\``
                    );

                    // Create table in debug database
                    await connection.query(createTableSql);

                    logger.debug('DebugDbSetup', 'Table structure created', { tableName });

                } catch (error) {
                    logger.error('DebugDbSetup', `Error creating table structure ${tableName}`, {
                        error: error.message,
                        stack: error.stack,
                        tableName
                    });
                    throw error;
                }
            }

            // Second pass: Copy all data
            logger.debug('DebugDbSetup', 'Copying table data...');
            for (const tableRow of tables) {
                const tableName = tableRow.TABLE_NAME;

                try {
                    // Copy all data from production to debug
                    await connection.query(
                        `INSERT INTO \`${this.debugDbName}\`.\`${tableName}\` SELECT * FROM \`${this.productionDbName}\`.\`${tableName}\``
                    );

                    // Get row count
                    const [countResult] = await connection.query(
                        `SELECT COUNT(*) as count FROM \`${this.debugDbName}\`.\`${tableName}\``
                    );
                    const rowCount = countResult[0].count;

                    logger.info('DebugDbSetup', 'Table data copied', {
                        tableName,
                        rowsCopied: rowCount
                    });

                } catch (error) {
                    logger.error('DebugDbSetup', `Error copying data for table ${tableName}`, {
                        error: error.message,
                        stack: error.stack,
                        tableName
                    });
                    throw error;
                }
            }

            // Re-enable foreign key checks
            await connection.query('SET FOREIGN_KEY_CHECKS = 1');
            logger.debug('DebugDbSetup', 'Re-enabled foreign key checks');

            logger.info('DebugDbSetup', '=== Debug database setup complete ===', {
                debugDbName: this.debugDbName,
                tablesCopied: tables.length
            });

        } catch (error) {
            logger.error('DebugDbSetup', 'Failed to setup debug database', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        } finally {
            if (connection) {
                await connection.end();
                logger.debug('DebugDbSetup', 'Setup connection closed');
            }
        }
    }
}

module.exports = DebugDbSetup;
