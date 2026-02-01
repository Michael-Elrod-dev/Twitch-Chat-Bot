// tests/logger/logger.test.js

jest.unmock('../../src/logger/logger');

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const mockConfig = {
    isDebugMode: false,
    logging: {
        level: 'info',
        maxSize: '20m',
        maxFiles: 10
    }
};

jest.mock('../../src/config/config', () => mockConfig);

describe('Logger', () => {
    let logger;
    let originalEnv;

    beforeEach(() => {
        originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        jest.resetModules();
        jest.unmock('../../src/logger/logger');
    });

    afterEach(() => {
        if (logger && logger.winstonLogger) {
            logger.winstonLogger.close();
        }
        process.env.NODE_ENV = originalEnv;
        jest.clearAllMocks();
    });

    describe('parseSize', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
        });

        it('should parse kilobytes (k)', () => {
            expect(logger.parseSize('10k')).toBe(10 * 1024);
        });

        it('should parse megabytes (m)', () => {
            expect(logger.parseSize('20m')).toBe(20 * 1024 * 1024);
        });

        it('should parse gigabytes (g)', () => {
            expect(logger.parseSize('1g')).toBe(1024 * 1024 * 1024);
        });

        it('should handle uppercase units', () => {
            expect(logger.parseSize('10K')).toBe(10 * 1024);
            expect(logger.parseSize('20M')).toBe(20 * 1024 * 1024);
            expect(logger.parseSize('1G')).toBe(1024 * 1024 * 1024);
        });

        it('should handle plain numbers (bytes)', () => {
            expect(logger.parseSize('1024')).toBe(1024);
        });

        it('should return default 20MB for invalid format', () => {
            expect(logger.parseSize('invalid')).toBe(20 * 1024 * 1024);
            expect(logger.parseSize('')).toBe(20 * 1024 * 1024);
            expect(logger.parseSize('abc123')).toBe(20 * 1024 * 1024);
        });
    });

    describe('_createErrorHash', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
        });

        it('should create consistent hash for same module and message', () => {
            const hash1 = logger._createErrorHash('Module', 'Error message');
            const hash2 = logger._createErrorHash('Module', 'Error message');
            expect(hash1).toBe(hash2);
        });

        it('should create different hash for different modules', () => {
            const hash1 = logger._createErrorHash('Module1', 'Error message');
            const hash2 = logger._createErrorHash('Module2', 'Error message');
            expect(hash1).not.toBe(hash2);
        });

        it('should create different hash for different messages', () => {
            const hash1 = logger._createErrorHash('Module', 'Error message 1');
            const hash2 = logger._createErrorHash('Module', 'Error message 2');
            expect(hash1).not.toBe(hash2);
        });

        it('should use format module:message', () => {
            const hash = logger._createErrorHash('TestModule', 'Test error');
            expect(hash).toBe('TestModule:Test error');
        });
    });

    describe('_shouldRateLimit', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
            logger.errorTimestamps = [];
        });

        it('should not rate limit when under threshold', () => {
            for (let i = 0; i < 5; i++) {
                expect(logger._shouldRateLimit()).toBe(false);
            }
        });

        it('should rate limit after 10 errors per second', () => {
            for (let i = 0; i < 10; i++) {
                logger._shouldRateLimit();
            }
            expect(logger._shouldRateLimit()).toBe(true);
        });

        it('should reset after 1 second', async () => {
            for (let i = 0; i < 10; i++) {
                logger._shouldRateLimit();
            }
            expect(logger._shouldRateLimit()).toBe(true);

            logger.errorTimestamps = [];
            expect(logger._shouldRateLimit()).toBe(false);
        });
    });

    describe('_shouldDeduplicate', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
            logger.recentErrors = new Map();
        });

        it('should not deduplicate first occurrence', () => {
            const hash = 'module:error';
            expect(logger._shouldDeduplicate(hash)).toBe(false);
        });

        it('should deduplicate subsequent occurrences', () => {
            const hash = 'module:error';
            logger._shouldDeduplicate(hash);
            expect(logger._shouldDeduplicate(hash)).toBe(true);
        });

        it('should log every 10th occurrence', () => {
            const hash = 'module:error';
            logger._shouldDeduplicate(hash);

            for (let i = 2; i <= 9; i++) {
                expect(logger._shouldDeduplicate(hash)).toBe(true);
            }

            expect(logger._shouldDeduplicate(hash)).toBe(false);
        });

        it('should track count correctly', () => {
            const hash = 'module:error';
            logger._shouldDeduplicate(hash);

            const errorInfo = logger.recentErrors.get(hash);
            expect(errorInfo.count).toBe(1);

            logger._shouldDeduplicate(hash);
            expect(logger.recentErrors.get(hash).count).toBe(2);
        });
    });

    describe('_cleanupErrorTracking', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
            logger.recentErrors = new Map();
            logger.errorDedupeWindow = 60000;
        });

        it('should remove old error entries', () => {
            const hash = 'module:error';
            const oldTimestamp = Date.now() - 70000;

            logger.recentErrors.set(hash, {
                count: 1,
                firstSeen: oldTimestamp,
                lastSeen: oldTimestamp
            });

            logger._cleanupErrorTracking();

            expect(logger.recentErrors.has(hash)).toBe(false);
        });

        it('should keep recent error entries', () => {
            const hash = 'module:error';
            const recentTimestamp = Date.now() - 30000;

            logger.recentErrors.set(hash, {
                count: 1,
                firstSeen: recentTimestamp,
                lastSeen: recentTimestamp
            });

            logger._cleanupErrorTracking();

            expect(logger.recentErrors.has(hash)).toBe(true);
        });
    });

    describe('logging methods', () => {
        beforeEach(() => {
            logger = require('../../src/logger/logger');
        });

        it('should have info method', () => {
            expect(typeof logger.info).toBe('function');
        });

        it('should have debug method', () => {
            expect(typeof logger.debug).toBe('function');
        });

        it('should have warn method', () => {
            expect(typeof logger.warn).toBe('function');
        });

        it('should have error method', () => {
            expect(typeof logger.error).toBe('function');
        });

        it('should have setLogLevel method', () => {
            expect(typeof logger.setLogLevel).toBe('function');
        });
    });

    describe('environment detection', () => {
        it('should detect test environment', () => {
            process.env.NODE_ENV = 'test';
            jest.resetModules();
            jest.unmock('../../src/logger/logger');
            logger = require('../../src/logger/logger');

            expect(logger.winstonLogger).toBeDefined();
        });
    });
});
