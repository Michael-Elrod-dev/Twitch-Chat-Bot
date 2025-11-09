// src/logger/logger.js

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const config = require('../config/config');

class Logger {
    constructor() {
        this.logDirectory = path.join(__dirname, 'logs');

        // Define custom format for log messages
        const customFormat = winston.format.printf(({ timestamp, level, message, module, userId, ...metadata }) => {
            const moduleFormatted = module ? `[${module.padEnd(20)}]` : '[General             ]';
            const userInfo = userId ? `[${userId}] ` : '';
            const metaStr = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';

            return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${moduleFormatted} ${userInfo}${message}${metaStr}`;
        });

        // Console transport - only for important startup/shutdown messages
        const consoleTransport = new winston.transports.Console({
            level: 'info', // Only show info and above in console
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, module }) => {
                    const moduleStr = module ? `[${module}]` : '';
                    return `${timestamp} ${level} ${moduleStr} ${message}`;
                })
            )
        });

        // Main log file - all logs with size-based rotation
        const mainFileTransport = new DailyRotateFile({
            filename: 'bot-%DATE%.log',
            dirname: this.logDirectory,
            datePattern: 'YYYY-MM-DD-HHmmss', // Timestamp when app starts (unique per run)
            maxSize: config.logging.maxSize || '20m', // Rotate when file reaches this size
            maxFiles: config.logging.maxFiles || 10, // Keep max 10 files total
            zippedArchive: false, // Don't compress old files
            level: config.logging.level || 'info',
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                customFormat
            )
        });

        // Error log file - errors only with size-based rotation
        const errorFileTransport = new DailyRotateFile({
            filename: 'error-%DATE%.log',
            dirname: this.logDirectory,
            datePattern: 'YYYY-MM-DD-HHmmss', // Timestamp when app starts
            maxSize: config.logging.maxSize || '20m',
            maxFiles: config.logging.maxFiles || 10,
            zippedArchive: false,
            level: 'error',
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                customFormat
            )
        });

        // Create the Winston logger
        this.winstonLogger = winston.createLogger({
            level: config.logging.level || 'info',
            transports: [
                consoleTransport,
                mainFileTransport,
                errorFileTransport
            ]
        });

        // Log initialization
        this.info('Logger', 'Logger initialized', {
            logLevel: config.logging.level || 'info',
            maxSize: config.logging.maxSize || '20m',
            maxFiles: config.logging.maxFiles || 10,
            logDirectory: this.logDirectory
        });
    }

    /**
     * Log an error message
     * @param {string} module - Module name (e.g., 'WebSocketManager')
     * @param {string} message - Log message
     * @param {Object} metadata - Additional metadata (error object, userId, etc.)
     */
    error(module, message, metadata = {}) {
        this.winstonLogger.error(message, { module, ...metadata });
    }

    /**
     * Log an info message
     * @param {string} module - Module name (e.g., 'WebSocketManager')
     * @param {string} message - Log message
     * @param {Object} metadata - Additional metadata (userId, etc.)
     */
    info(module, message, metadata = {}) {
        this.winstonLogger.info(message, { module, ...metadata });
    }

    /**
     * Log a debug message
     * @param {string} module - Module name (e.g., 'WebSocketManager')
     * @param {string} message - Log message
     * @param {Object} metadata - Additional metadata
     */
    debug(module, message, metadata = {}) {
        this.winstonLogger.debug(message, { module, ...metadata });
    }

    /**
     * Log a warning message
     * @param {string} module - Module name (e.g., 'WebSocketManager')
     * @param {string} message - Log message
     * @param {Object} metadata - Additional metadata
     */
    warn(module, message, metadata = {}) {
        this.winstonLogger.warn(message, { module, ...metadata });
    }

    /**
     * Update log level dynamically
     * @param {string} level - New log level ('debug', 'info', 'warn', 'error')
     */
    setLogLevel(level) {
        this.winstonLogger.level = level;
        this.info('Logger', `Log level changed to: ${level}`);
    }
}

// Export singleton instance
module.exports = new Logger();
