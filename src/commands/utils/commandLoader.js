// src/commands/utils/commandLoader.js

const fs = require('fs');
const path = require('path');
const logger = require('../../logger/logger');

function loadCommandHandlers(dependencies) {
    const handlers = {};
    const handlersDir = path.join(__dirname, '..', 'handlers');

    try {
        if (!fs.existsSync(handlersDir)) {
            logger.warn('CommandLoader', 'Handlers directory does not exist', { path: handlersDir });
            return handlers;
        }

        const handlerFiles = fs.readdirSync(handlersDir)
            .filter(file => file.endsWith('.js'));

        logger.info('CommandLoader', 'Loading command handlers', {
            handlersDir,
            fileCount: handlerFiles.length,
            files: handlerFiles
        });

        for (const file of handlerFiles) {
            try {
                const filePath = path.join(handlersDir, file);
                const handlerModule = require(filePath);

                if (typeof handlerModule === 'function') {
                    const moduleHandlers = handlerModule(dependencies);

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
