// jest.setup.js

// Global setup for all tests - runs before each test file

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Suppress console output during tests for cleaner output
// Tests that specifically verify console.error/log calls will override these mocks
global.console = {
    ...console,
    // Keep console methods that are useful for debugging test failures
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};
