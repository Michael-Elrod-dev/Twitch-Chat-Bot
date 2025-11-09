// src/logger/logger.js

const fs = require('fs');
const path = require('path');
const { LOG_LEVELS, RESET_COLOR } = require('./logLevels');
const config = require('../config/config');

class Logger {
    constructor(options = {}) {
        this.logLevel = options.logLevel || config.logging.level;
        this.logDirectory = options.logDirectory || path.join(__dirname, 'logs');
        this.maxLogFiles = options.maxLogFiles || config.logging.maxLogFiles;

        this.ensureLogDirectory();
        this.currentDate = this.getCurrentDate();
        this.cleanupOldLogs();
        this.setupLogFiles();
    }

    ensureLogDirectory() {
        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
    }

    getCurrentDate() {
        return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    }

    cleanupOldLogs() {
        try {
            const files = fs.readdirSync(this.logDirectory);

            const botLogFiles = files.filter(file =>
                /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(file)
            ).sort();

            const errorLogFiles = files.filter(file =>
                /^errors-\d{4}-\d{2}-\d{2}\.log$/.test(file)
            ).sort();

            this.removeOldFiles(botLogFiles, 'bot logs');
            this.removeOldFiles(errorLogFiles, 'error logs');

        } catch (error) {
            console.error('❌ Error during log cleanup:', error.message);
        }
    }

    removeOldFiles(fileList, logType) {
        if (fileList.length <= this.maxLogFiles) {
            console.log(`📁 ${logType}: ${fileList.length} files (within limit of ${this.maxLogFiles})`);
            return;
        }

        const filesToDelete = fileList.length - this.maxLogFiles;
        const filesToRemove = fileList.slice(0, filesToDelete);

        console.log(`🧹 Cleaning up ${logType}: removing ${filesToDelete} old files`);

        filesToRemove.forEach(file => {
            try {
                const filePath = path.join(this.logDirectory, file);
                const stats = fs.statSync(filePath);
                const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                fs.unlinkSync(filePath);
                console.log(`   ✅ Deleted: ${file} (${fileSizeMB}MB)`);
            } catch (error) {
                console.error(`   ❌ Failed to delete ${file}:`, error.message);
            }
        });

        console.log(`📁 ${logType}: ${fileList.length - filesToDelete} files remaining`);
    }

    getLogFilesSummary() {
        try {
            const files = fs.readdirSync(this.logDirectory);

            const botLogFiles = files.filter(file =>
                /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(file)
            );

            const errorLogFiles = files.filter(file =>
                /^errors-\d{4}-\d{2}-\d{2}\.log$/.test(file)
            );

            let totalSize = 0;
            const allLogFiles = [...botLogFiles, ...errorLogFiles];

            allLogFiles.forEach(file => {
                try {
                    const filePath = path.join(this.logDirectory, file);
                    const stats = fs.statSync(filePath);
                    totalSize += stats.size;
                } catch (error) {
                    // File might have been deleted, ignore
                }
            });

            const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

            return {
                botLogCount: botLogFiles.length,
                errorLogCount: errorLogFiles.length,
                totalFiles: allLogFiles.length,
                totalSizeMB: totalSizeMB,
                oldestBotLog: botLogFiles.sort()[0] || null,
                newestBotLog: botLogFiles.sort().pop() || null
            };
        } catch (error) {
            console.error('❌ Error getting log files summary:', error.message);
            return null;
        }
    }

    setupLogFiles() {
        const today = this.getCurrentDate();
        if (today !== this.currentDate) {
            this.currentDate = today;
            this.cleanupOldLogs();
        }

        this.mainLogFile = path.join(this.logDirectory, `bot-${this.currentDate}.log`);
        this.errorLogFile = path.join(this.logDirectory, `errors-${this.currentDate}.log`);
        this.latestLogFile = path.join(this.logDirectory, 'latest.log');

        // Create symlink to latest log
        try {
            if (fs.existsSync(this.latestLogFile)) {
                fs.unlinkSync(this.latestLogFile);
            }
            fs.symlinkSync(path.basename(this.mainLogFile), this.latestLogFile);
        } catch (error) {
            // Symlink creation failed (probably Windows), just continue
        }

        // Log the summary when setting up files
        const summary = this.getLogFilesSummary();
        if (summary) {
            console.log(`📊 Log Files Summary: ${summary.totalFiles} files, ${summary.totalSizeMB}MB total`);
            if (summary.oldestBotLog && summary.newestBotLog) {
                console.log(`📅 Date Range: ${summary.oldestBotLog.replace('bot-', '').replace('.log', '')} → ${summary.newestBotLog.replace('bot-', '').replace('.log', '')}`);
            }
        }
    }

    formatMessage(level, module, action, details, userId = null) {
        const timestamp = new Date().toISOString();
        const levelName = LOG_LEVELS[level].name.padEnd(6);
        const moduleFormatted = module.padEnd(15);

        let userInfo = '';
        if (userId) {
            userInfo = `[${userId}] `;
        }

        return `${timestamp} [${levelName}] [${moduleFormatted}] ${userInfo}${action} - ${details}`;
    }

    writeToConsole(level, message) {
        const color = LOG_LEVELS[level].color;
        console.log(`${color}${message}${RESET_COLOR}`);
    }

    writeToFile(message, isError = false) {
        const today = this.getCurrentDate();
        if (today !== this.currentDate) {
            this.setupLogFiles();
        }

        try {
            fs.appendFileSync(this.mainLogFile, message + '\n');

            if (isError) {
                fs.appendFileSync(this.errorLogFile, message + '\n');
            }
        } catch (error) {
            console.error('❌ Failed to write to log file:', error.message);
        }
    }

    log(level, module, action, details, userId = null, error = null) {
        const levelConfig = LOG_LEVELS[level];

        if (levelConfig.level > this.logLevel) return;

        const message = this.formatMessage(level, module, action, details, userId);
        const isError = level === 'ERROR';

        let fullMessage = message;
        if (error && error.stack) {
            fullMessage += `\nStack Trace:\n${error.stack}`;
        }

        this.writeToConsole(level, message);
        this.writeToFile(fullMessage, isError);
    }

    // The 3 main logging methods
    error(module, action, details, userId = null, error = null) {
        this.log('ERROR', module, action, details, userId, error);
    }

    user(module, action, details, userId) {
        this.log('USER', module, action, details, userId);
    }

    system(module, action, details) {
        this.log('SYSTEM', module, action, details);
    }

    // Utility methods
    forceCleanup() {
        console.log('🧹 Force cleaning up old log files...');
        this.cleanupOldLogs();
    }

    setMaxLogFiles(newMax) {
        this.maxLogFiles = newMax;
        console.log(`📁 Updated max log files to: ${newMax}`);
        this.cleanupOldLogs();
    }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger;
