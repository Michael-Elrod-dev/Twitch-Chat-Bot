// src/logger/logLevels.js

const LOG_LEVELS = {
    ERROR: { level: 0, name: 'ERROR', color: '\x1b[31m' },    // Red - Errors & Warnings
    USER:  { level: 1, name: 'USER',  color: '\x1b[35m' },    // Magenta - User actions
    SYSTEM:{ level: 2, name: 'SYSTEM',color: '\x1b[36m' }     // Cyan - Bot processes
};

const RESET_COLOR = '\x1b[0m';

module.exports = { LOG_LEVELS, RESET_COLOR };
