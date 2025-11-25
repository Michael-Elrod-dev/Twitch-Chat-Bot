// src/api/apiServer.js

const express = require('express');
const logger = require('../logger/logger');
const { apiKeyAuth } = require('./middleware/auth');
const createSongsRouter = require('./routes/songsRouter');

class ApiServer {
    constructor(config, songToggleService, messageSender) {
        this.config = config;
        this.songToggleService = songToggleService;
        this.messageSender = messageSender;
        this.app = express();
        this.server = null;
    }

    setupMiddleware() {
        this.app.use(express.json());

        this.app.use((req, res, next) => {
            logger.debug('API', 'Incoming request', {
                method: req.method,
                path: req.path,
                ip: req.ip
            });
            next();
        });
    }

    setupRoutes() {
        this.app.get('/health', (req, res) => {
            res.json({
                success: true,
                status: 'healthy',
                uptime: process.uptime()
            });
        });

        const songsRouter = createSongsRouter(this.songToggleService, this.config, this.messageSender);
        this.app.use('/api/songs', apiKeyAuth(this.config), songsRouter);

        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found'
            });
        });

        this.app.use((err, req, res, next) => {
            logger.error('API', 'Unhandled error', {
                error: err.message,
                stack: err.stack,
                path: req.path
            });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }

    async start() {
        if (!this.config.apiEnabled) {
            logger.info('API', 'API server disabled in config');
            return;
        }

        if (!this.config.apiKey) {
            logger.error('API', 'API key not configured, cannot start API server');
            return;
        }

        this.setupMiddleware();
        this.setupRoutes();

        return new Promise((resolve, reject) => {
            try {
                this.server = this.app.listen(this.config.apiPort, '127.0.0.1', () => {
                    logger.info('API', 'API server started', {
                        port: this.config.apiPort,
                        host: '127.0.0.1'
                    });
                    resolve();
                });

                this.server.on('error', (error) => {
                    logger.error('API', 'Server error', {
                        error: error.message,
                        stack: error.stack
                    });
                    reject(error);
                });
            } catch (error) {
                logger.error('API', 'Failed to start API server', {
                    error: error.message,
                    stack: error.stack
                });
                reject(error);
            }
        });
    }

    async stop() {
        if (!this.server) {
            return;
        }

        return new Promise((resolve) => {
            this.server.close(() => {
                logger.info('API', 'API server stopped');
                resolve();
            });
        });
    }
}

module.exports = ApiServer;
