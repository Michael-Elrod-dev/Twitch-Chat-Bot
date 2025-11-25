// src/api/middleware/auth.js

const logger = require('../../logger/logger');

function apiKeyAuth(config) {
    return (req, res, next) => {
        const apiKey = req.headers['x-api-key'];

        if (!apiKey) {
            logger.warn('API', 'Missing API key', {
                ip: req.ip,
                path: req.path
            });
            return res.status(401).json({
                success: false,
                error: 'Missing API key'
            });
        }

        if (apiKey !== config.apiKey) {
            logger.warn('API', 'Invalid API key', {
                ip: req.ip,
                path: req.path
            });
            return res.status(403).json({
                success: false,
                error: 'Invalid API key'
            });
        }

        next();
    };
}

module.exports = { apiKeyAuth };
