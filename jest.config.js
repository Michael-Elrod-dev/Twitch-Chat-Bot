// jest.config.js

module.exports = {
    testEnvironment: 'node',

    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

    testMatch: [
        '**/tests/**/*.test.js',
        '**/__tests__/**/*.js'
    ],

    collectCoverageFrom: [
        'src/**/*.js',
        '!src/bot.js',
        '!src/logger/**',
        '!**/node_modules/**'
    ],

    coverageThreshold: {
        global: {
            branches: 70,
            functions: 75,
            lines: 75,
            statements: 75
        }
    },

    coverageReporters: [
        'text',
        'text-summary',
        'html',
        'lcov'
    ],

    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,

    verbose: true,

    testTimeout: 10000
};
