// src/logger/logger.js

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

class Logger {
    constructor() {
        this.logDirectory = path.join(__dirname, 'logs');
        this.configDirectory = path.join(__dirname, 'config');

        // Create directories if they don't exist
        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.configDirectory)) {
            fs.mkdirSync(this.configDirectory, { recursive: true });
        }

        // Error deduplication - track recent errors to prevent spam
        this.recentErrors = new Map(); // key: error hash, value: { count, firstSeen, lastSeen }
        this.errorDedupeWindow = 60000; // 60 seconds - don't log identical errors within this window
        this.errorRateLimit = 10; // Max errors per second
        this.errorTimestamps = []; // Track recent error timestamps

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
            auditFile: path.join(this.configDirectory, 'bot-audit.json'),
            datePattern: 'YYYY-MM-DD', // Daily rotation
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
            auditFile: path.join(this.configDirectory, 'error-audit.json'),
            datePattern: 'YYYY-MM-DD', // Daily rotation
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
     * Create a hash for error deduplication
     * @param {string} module - Module name
     * @param {string} message - Error message
     * @returns {string} Hash key for deduplication
     */
    _createErrorHash(module, message) {
        // Simple hash based on module and message (ignore metadata for deduplication)
        return `${module}:${message}`;
    }

    /**
     * Check if we should rate limit this error
     * @returns {boolean} True if we should skip logging due to rate limit
     */
    _shouldRateLimit() {
        const now = Date.now();
        // Remove timestamps older than 1 second
        this.errorTimestamps = this.errorTimestamps.filter(ts => now - ts < 1000);

        if (this.errorTimestamps.length >= this.errorRateLimit) {
            return true; // Rate limit exceeded
        }

        this.errorTimestamps.push(now);
        return false;
    }

    /**
     * Check if this error should be deduplicated
     * @param {string} errorHash - Hash of the error
     * @returns {boolean} True if we should skip logging due to deduplication
     */
    _shouldDeduplicate(errorHash) {
        const now = Date.now();
        const errorInfo = this.recentErrors.get(errorHash);

        if (errorInfo) {
            const timeSinceFirst = now - errorInfo.firstSeen;

            // If within deduplication window, increment count and update lastSeen
            if (timeSinceFirst < this.errorDedupeWindow) {
                errorInfo.count++;
                errorInfo.lastSeen = now;
                this.recentErrors.set(errorHash, errorInfo);

                // Log a summary every 10 occurrences
                return errorInfo.count % 10 !== 0;
                // Skip logging
            } else {
                // Outside window, reset
                this.recentErrors.set(errorHash, { count: 1, firstSeen: now, lastSeen: now });
                return false;
            }
        } else {
            // First time seeing this error
            this.recentErrors.set(errorHash, { count: 1, firstSeen: now, lastSeen: now });
            return false;
        }
    }

    /**
     * Clean up old error tracking data
     */
    _cleanupErrorTracking() {
        const now = Date.now();
        for (const [hash, info] of this.recentErrors.entries()) {
            if (now - info.lastSeen > this.errorDedupeWindow) {
                // Log final summary if there were multiple occurrences
                if (info.count > 1) {
                    const [module, message] = hash.split(':', 2);
                    this.winstonLogger.error(`[DEDUPE SUMMARY] Error occurred ${info.count} times in ${Math.round((info.lastSeen - info.firstSeen) / 1000)}s`, {
                        module,
                        originalMessage: message
                    });
                }
                this.recentErrors.delete(hash);
            }
        }
    }

    /**
     * Log an error message with deduplication and rate limiting
     * @param {string} module - Module name (e.g., 'WebSocketManager')
     * @param {string} message - Log message
     * @param {Object} metadata - Additional metadata (error object, userId, etc.)
     */
    error(module, message, metadata = {}) {
        // Check rate limiting
        if (this._shouldRateLimit()) {
            // Silently drop - we're being flooded
            return;
        }

        // Check deduplication
        const errorHash = this._createErrorHash(module, message);
        const errorInfo = this.recentErrors.get(errorHash);

        if (this._shouldDeduplicate(errorHash)) {
            // Skip logging, but error is tracked
            return;
        }

        // Add repetition count to metadata if this is a repeated error
        if (errorInfo && errorInfo.count > 1) {
            metadata.repetitions = errorInfo.count;
        }

        this.winstonLogger.error(message, { module, ...metadata });

        // Periodically clean up old tracking data
        if (Math.random() < 0.01) { // 1% chance to trigger cleanup
            this._cleanupErrorTracking();
        }
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
