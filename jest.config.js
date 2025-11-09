// jest.config.js

module.exports = {
    // Test environment
    testEnvironment: 'node',

    // Setup files
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

    // Test file patterns
    testMatch: [
        '**/tests/**/*.test.js',
        '**/__tests__/**/*.js'
    ],

    // Coverage settings
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/bot.js', // Main entry point - tested via integration
        '!src/logger/**', // Logger - simple utility
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

    // Coverage reporters
    coverageReporters: [
        'text',
        'text-summary',
        'html',
        'lcov'
    ],

    // Clear mocks between tests
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,

    // Verbose output
    verbose: true,

    // Timeout for async tests (increased for database operations)
    testTimeout: 10000
};
