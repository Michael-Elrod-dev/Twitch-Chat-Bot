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
        this.isConfigured = false;
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

        // Express identifies error middleware by arity, so the 4th parameter has
        // to stay even though nothing calls it.
        this.app.use((err, req, res, _next) => {
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

        if (this.server) {
            logger.debug('API', 'API server already listening, skipping start', {
                port: this.config.apiPort
            });
            return;
        }

        // Routes are registered once per instance - re-running them on a restart
        // would stack duplicate middleware on the same express app.
        if (!this.isConfigured) {
            this.setupMiddleware();
            this.setupRoutes();
            this.isConfigured = true;
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            try {
                const server = this.app.listen(this.config.apiPort, '127.0.0.1', () => {
                    settled = true;
                    this.server = server;
                    logger.info('API', 'API server started', {
                        port: this.config.apiPort,
                        host: '127.0.0.1'
                    });
                    resolve();
                });

                server.on('error', (error) => {
                    logger.error('API', 'Server error', {
                        error: error.message,
                        stack: error.stack
                    });

                    // Errors after a successful listen (a client socket blowing up,
                    // a late EADDRINUSE) must not settle an already-resolved promise.
                    if (settled) {
                        return;
                    }

                    settled = true;
                    reject(error);
                });
            } catch (error) {
                logger.error('API', 'Failed to start API server', {
                    error: error.message,
                    stack: error.stack
                });

                if (!settled) {
                    settled = true;
                    reject(error);
                }
            }
        });
    }

    async stop() {
        if (!this.server) {
            return;
        }

        // Dropped before closing so a failed close cannot leave a stale handle that
        // blocks the next start().
        const server = this.server;
        this.server = null;

        return new Promise((resolve) => {
            server.close(() => {
                logger.info('API', 'API server stopped');
                resolve();
            });
        });
    }
}

module.exports = ApiServer;
