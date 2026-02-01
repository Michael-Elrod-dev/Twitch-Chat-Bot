// tests/__mocks__/mockDbManager.js

/**
 * Creates a mock database manager for testing
 * @param {Object} options - Configuration options
 * @param {*} options.defaultQueryResult - Default result for query calls
 * @param {boolean} options.connected - Whether DB should appear connected
 * @returns {Object} Mock database manager
 */
const createMockDbManager = (options = {}) => {
    const {
        defaultQueryResult = [],
        connected = true
    } = options;

    return {
        query: jest.fn().mockResolvedValue(defaultQueryResult),
        connected: jest.fn().mockReturnValue(connected),
        getConnection: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue(defaultQueryResult),
            release: jest.fn()
        }),
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined)
    };
};

/**
 * Creates a mock database manager that simulates errors
 * @param {Error} error - The error to throw
 * @returns {Object} Mock database manager that throws errors
 */
const createErrorDbManager = (error = new Error('Database error')) => {
    return {
        query: jest.fn().mockRejectedValue(error),
        connected: jest.fn().mockReturnValue(false),
        getConnection: jest.fn().mockRejectedValue(error),
        beginTransaction: jest.fn().mockRejectedValue(error),
        commit: jest.fn().mockRejectedValue(error),
        rollback: jest.fn().mockRejectedValue(error)
    };
};

/**
 * Creates a mock database manager with transaction support
 * @returns {Object} Mock database manager with transaction helpers
 */
const createTransactionalDbManager = () => {
    const mockConnection = {
        query: jest.fn().mockResolvedValue([]),
        release: jest.fn(),
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined)
    };

    return {
        query: jest.fn().mockResolvedValue([]),
        connected: jest.fn().mockReturnValue(true),
        getConnection: jest.fn().mockResolvedValue(mockConnection),
        _mockConnection: mockConnection
    };
};

module.exports = {
    createMockDbManager,
    createErrorDbManager,
    createTransactionalDbManager
};
