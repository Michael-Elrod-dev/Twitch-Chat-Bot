// src/commands/utils/commandLoader.js

const fs = require('fs');
const path = require('path');
const logger = require('../../logger/logger');

/**
 * Automatically discovers and loads all command handlers from the handlers directory
 * @param {Object} dependencies - Dependencies to inject into command handlers
 * @returns {Object} Object mapping handler names to handler functions
 */
function loadCommandHandlers(dependencies) {
    const handlers = {};
    const handlersDir = path.join(__dirname, '..', 'handlers');

    try {
        // Check if handlers directory exists
        if (!fs.existsSync(handlersDir)) {
            logger.warn('CommandLoader', 'Handlers directory does not exist', { path: handlersDir });
            return handlers;
        }

        // Read all .js files from handlers directory
        const handlerFiles = fs.readdirSync(handlersDir)
            .filter(file => file.endsWith('.js'));

        logger.info('CommandLoader', 'Loading command handlers', {
            handlersDir,
            fileCount: handlerFiles.length,
            files: handlerFiles
        });

        // Load each handler file
        for (const file of handlerFiles) {
            try {
                const filePath = path.join(handlersDir, file);
                const handlerModule = require(filePath);

                // Handler modules should export a function that takes dependencies
                // and returns an object of handler functions
                if (typeof handlerModule === 'function') {
                    const moduleHandlers = handlerModule(dependencies);

                    // Merge handlers from this module
                    Object.assign(handlers, moduleHandlers);

                    logger.info('CommandLoader', 'Loaded handler module', {
                        file,
                        handlerCount: Object.keys(moduleHandlers).length,
                        handlers: Object.keys(moduleHandlers)
                    });
                } else {
                    logger.warn('CommandLoader', 'Handler file did not export a function', { file });
                }
            } catch (error) {
                logger.error('CommandLoader', 'Error loading handler file', {
                    file,
                    error: error.message,
                    stack: error.stack
                });
            }
        }

        logger.info('CommandLoader', 'Command handlers loaded successfully', {
            totalHandlers: Object.keys(handlers).length,
            handlerNames: Object.keys(handlers)
        });

        return handlers;
    } catch (error) {
        logger.error('CommandLoader', 'Error loading command handlers', {
            error: error.message,
            stack: error.stack
        });
        return handlers;
    }
}

module.exports = { loadCommandHandlers };
