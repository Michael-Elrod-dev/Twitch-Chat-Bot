// src/database/dbManager.js
const mysql = require('mysql2/promise');
const config = require('../config/config');

class DbManager {
    constructor() {
        this.connection = null;
    }

    async connect() {
        try {
            this.connection = await mysql.createConnection(config.database);
            console.log('✅ Connected to SQL database');
        } catch (error) {
            console.error('❌ Failed to connect to database:', error);
            throw error;
        }
    }

    async query(sql, params = []) {
        try {
            const transactionCommands = ['START TRANSACTION', 'COMMIT', 'ROLLBACK'];
            const isTransactionCommand = transactionCommands.some(cmd => 
                sql.trim().toUpperCase().startsWith(cmd)
            );
            
            if (isTransactionCommand || params.length === 0) {
                const [results] = await this.connection.query(sql, params);
                return results;
            } else {
                const [results] = await this.connection.execute(sql, params);
                return results;
            }
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async close() {
        if (this.connection) {
            await this.connection.end();
            this.connection = null;
        }
    }
}

module.exports = DbManager;