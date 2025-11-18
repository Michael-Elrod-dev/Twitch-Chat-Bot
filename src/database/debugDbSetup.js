// src/database/debugDbSetup.js

const mysql = require('mysql2/promise');
const config = require('../config/config');
const logger = require('../logger/logger');

class DebugDbSetup {
    constructor() {
        this.productionDbName = process.env.DB_NAME;
        this.debugDbName = process.env.DB_NAME + '_debug';
    }

    async setupDebugDatabase() {
        let connection = null;

        try {
            logger.info('DebugDbSetup', '=== Setting up debug database ===');

            connection = await mysql.createConnection({
                host: config.database.host,
                port: config.database.port,
                user: config.database.user,
                password: config.database.password
            });

            logger.info('DebugDbSetup', 'Connected to MySQL server');

            logger.info('DebugDbSetup', 'Checking for existing debug database', { debugDbName: this.debugDbName });
            await connection.query(`DROP DATABASE IF EXISTS \`${this.debugDbName}\``);
            logger.info('DebugDbSetup', 'Dropped existing debug database (if any)');

            logger.info('DebugDbSetup', 'Creating new debug database', { debugDbName: this.debugDbName });
            await connection.query(`CREATE DATABASE \`${this.debugDbName}\``);
            logger.info('DebugDbSetup', 'Debug database created successfully');

            logger.info('DebugDbSetup', 'Copying schema from production', {
                productionDb: this.productionDbName,
                debugDb: this.debugDbName
            });

            await connection.query('SET FOREIGN_KEY_CHECKS = 0');
            logger.debug('DebugDbSetup', 'Disabled foreign key checks');

            const [tables] = await connection.query(
                'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?',
                [this.productionDbName]
            );

            logger.info('DebugDbSetup', 'Found tables to copy', { tableCount: tables.length });

            logger.debug('DebugDbSetup', 'Creating table structures...');
            for (const tableRow of tables) {
                const tableName = tableRow.TABLE_NAME;

                try {
                    const [createTableResult] = await connection.query(
                        `SHOW CREATE TABLE \`${this.productionDbName}\`.\`${tableName}\``
                    );

                    let createTableSql = createTableResult[0]['Create Table'];

                    createTableSql = createTableSql.replace(
                        `CREATE TABLE \`${tableName}\``,
                        `CREATE TABLE \`${this.debugDbName}\`.\`${tableName}\``
                    );

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

            logger.debug('DebugDbSetup', 'Copying table data...');
            for (const tableRow of tables) {
                const tableName = tableRow.TABLE_NAME;

                try {
                    await connection.query(
                        `INSERT INTO \`${this.debugDbName}\`.\`${tableName}\` SELECT * FROM \`${this.productionDbName}\`.\`${tableName}\``
                    );

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
