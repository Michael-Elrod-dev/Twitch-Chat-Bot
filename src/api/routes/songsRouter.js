// src/api/routes/songsRouter.js

const express = require('express');
const logger = require('../../logger/logger');

function createSongsRouter(songToggleService, config, messageSender) {
    const router = express.Router();

    router.get('/status', async (req, res) => {
        try {
            const enabled = await songToggleService.getCurrentStatus(config.channelName);

            if (enabled === null) {
                return res.status(500).json({
                    success: false,
                    error: 'Could not determine song request status'
                });
            }

            res.json({
                success: true,
                enabled: enabled
            });
        } catch (error) {
            logger.error('API', 'Error getting song status', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    });

    router.post('/toggle', async (req, res) => {
        try {
            const result = await songToggleService.toggle(config.channelName);

            if (!result.success) {
                return res.status(500).json({
                    success: false,
                    error: result.message
                });
            }

            logger.info('API', 'Song requests toggled via API', {
                enabled: result.enabled
            });

            // Send message to chat
            try {
                await messageSender.sendMessage(config.channelName, result.message);
            } catch (chatError) {
                logger.error('API', 'Failed to send chat message', {
                    error: chatError.message
                });
            }

            res.json({
                success: true,
                enabled: result.enabled,
                message: result.message
            });
        } catch (error) {
            logger.error('API', 'Error toggling songs', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    });

    router.post('/enable', async (req, res) => {
        try {
            const result = await songToggleService.toggleSongs(config.channelName, true);

            if (!result.success) {
                return res.status(500).json({
                    success: false,
                    error: result.message
                });
            }

            logger.info('API', 'Song requests enabled via API', {
                alreadyEnabled: result.alreadyInState
            });

            // Send message to chat
            try {
                await messageSender.sendMessage(config.channelName, result.message);
            } catch (chatError) {
                logger.error('API', 'Failed to send chat message', {
                    error: chatError.message
                });
            }

            res.json({
                success: true,
                enabled: true,
                message: result.message
            });
        } catch (error) {
            logger.error('API', 'Error enabling songs', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    });

    router.post('/disable', async (req, res) => {
        try {
            const result = await songToggleService.toggleSongs(config.channelName, false);

            if (!result.success) {
                return res.status(500).json({
                    success: false,
                    error: result.message
                });
            }

            logger.info('API', 'Song requests disabled via API', {
                alreadyDisabled: result.alreadyInState
            });

            // Send message to chat
            try {
                await messageSender.sendMessage(config.channelName, result.message);
            } catch (chatError) {
                logger.error('API', 'Failed to send chat message', {
                    error: chatError.message
                });
            }

            res.json({
                success: true,
                enabled: false,
                message: result.message
            });
        } catch (error) {
            logger.error('API', 'Error disabling songs', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    });

    return router;
}

module.exports = createSongsRouter;
