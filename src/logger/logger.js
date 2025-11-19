// src/logger/logger.js

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

class Logger {
    constructor() {
        this.logDirectory = path.join(__dirname, 'logs');
        this.configDirectory = path.join(__dirname, 'config');

        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.configDirectory)) {
            fs.mkdirSync(this.configDirectory, { recursive: true });
        }

        this.recentErrors = new Map();
        this.errorDedupeWindow = 60000;
        this.errorRateLimit = 10;
        this.errorTimestamps = [];

        const customFormat = winston.format.printf(({ timestamp, level, message, module, userId, ...metadata }) => {
            const moduleFormatted = module ? `[${module.padEnd(20)}]` : '[General             ]';
            const userInfo = userId ? `[${userId}] ` : '';
            const metaStr = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : '';

            return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${moduleFormatted} ${userInfo}${message}${metaStr}`;
        });

        const consoleTransport = new winston.transports.Console({
            level: 'info',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format((info) => {
                    if (info.level === 'warn' || info.level === 'error') {
                        return info;
                    }

                    if (info.level === 'info' && (info.module === 'Bot' || info.module === 'Logger')) {
                        return info;
                    }

                    return false;
                })(),
                winston.format.printf(({ timestamp, level, message, module }) => {
                    const moduleStr = module ? `[${module}]` : '';
                    return `${timestamp} ${level} ${moduleStr} ${message}`;
                })
            )
        });

        const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
        const transports = [consoleTransport];

        if (!isTestEnvironment) {
            const filename = config.isDebugMode ? 'debug-bot.log' : 'bot.log';
            const fileTransport = new winston.transports.File({
                filename: path.join(this.logDirectory, filename),
                maxsize: this.parseSize(config.logging.maxSize || '20m'),
                maxFiles: config.logging.maxFiles || 10,
                tailable: true,
                level: config.logging.level || 'info',
                format: winston.format.combine(
                    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                    customFormat
                )
            });
            transports.push(fileTransport);
        }

        this.winstonLogger = winston.createLogger({
            level: config.logging.level || 'info',
            transports: transports
        });

        this.info('Logger', 'Logger initialized', {
            debugMode: config.isDebugMode,
            logLevel: config.logging.level || 'info',
            maxSize: config.logging.maxSize || '20m',
            maxFiles: config.logging.maxFiles || 10,
            logDirectory: this.logDirectory
        });
    }

    parseSize(sizeString) {
        const units = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
        const match = sizeString.toLowerCase().match(/^(\d+)([kmg])?$/);
        if (!match) return 20 * 1024 * 1024; // Default 20MB
        const value = parseInt(match[1]);
        const unit = match[2] || 'b';
        return value * (units[unit] || 1);
    }

    _createErrorHash(module, message) {
        return `${module}:${message}`;
    }

    _shouldRateLimit() {
        const now = Date.now();
        this.errorTimestamps = this.errorTimestamps.filter(ts => now - ts < 1000);

        if (this.errorTimestamps.length >= this.errorRateLimit) {
            return true;
        }

        this.errorTimestamps.push(now);
        return false;
    }

    _shouldDeduplicate(errorHash) {
        const now = Date.now();
        const errorInfo = this.recentErrors.get(errorHash);

        if (errorInfo) {
            const timeSinceFirst = now - errorInfo.firstSeen;

            if (timeSinceFirst < this.errorDedupeWindow) {
                errorInfo.count++;
                errorInfo.lastSeen = now;
                this.recentErrors.set(errorHash, errorInfo);

                return errorInfo.count % 10 !== 0;
            } else {
                this.recentErrors.set(errorHash, { count: 1, firstSeen: now, lastSeen: now });
                return false;
            }
        } else {
            this.recentErrors.set(errorHash, { count: 1, firstSeen: now, lastSeen: now });
            return false;
        }
    }

    _cleanupErrorTracking() {
        const now = Date.now();
        for (const [hash, info] of this.recentErrors.entries()) {
            if (now - info.lastSeen > this.errorDedupeWindow) {
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

    error(module, message, metadata = {}) {
        if (this._shouldRateLimit()) {
            return;
        }

        const errorHash = this._createErrorHash(module, message);
        const errorInfo = this.recentErrors.get(errorHash);

        if (this._shouldDeduplicate(errorHash)) {
            return;
        }

        if (errorInfo && errorInfo.count > 1) {
            metadata.repetitions = errorInfo.count;
        }

        this.winstonLogger.error(message, { module, ...metadata });

        if (Math.random() < 0.01) {
            this._cleanupErrorTracking();
        }
    }

    info(module, message, metadata = {}) {
        this.winstonLogger.info(message, { module, ...metadata });
    }

    debug(module, message, metadata = {}) {
        this.winstonLogger.debug(message, { module, ...metadata });
    }

    warn(module, message, metadata = {}) {
        this.winstonLogger.warn(message, { module, ...metadata });
    }

    setLogLevel(level) {
        this.winstonLogger.level = level;
        this.info('Logger', `Log level changed to: ${level}`);
    }
}

module.exports = new Logger();
