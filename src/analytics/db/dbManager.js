// src/analytics/db/dbManager.js
const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../../config/config');

class DbManager {
    constructor() {
        this.connection = null;
        this.dbConfig = this.loadDbConfig();
    }

    loadDbConfig() {
        try {
            const configFile = fs.readFileSync(config.dbConfigPath, 'utf8');
            return JSON.parse(configFile);
        } catch (error) {
            console.error('❌ Error reading database config:', error);
            throw new Error('Unable to load database configuration from db.json');
        }
    }

    async connect() {
        try {
            this.connection = await mysql.createConnection(this.dbConfig);
            console.log('✅ Connected to SQL database');
        } catch (error) {
            console.error('❌ Failed to connect to database:', error);
            throw error;
        }
    }

    async query(sql, params = []) {
        try {
            const [results] = await this.connection.execute(sql, params);
            return results;
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