/**
 * These mocks mirror the real DbManager interface exactly: connect, query,
 * withTransaction, close. Nothing else. If you find yourself wanting another
 * method here, add it to DbManager first - a mock that advertises methods the
 * real class lacks is how a whole subsystem stayed untested.
 */

/**
 * Creates a mock database manager for testing
 * @param {Object} options - Configuration options
 * @param {*} options.defaultQueryResult - Default result for query calls
 * @param {*} options.transactionQueryResult - Default result for queries run inside
 *   a withTransaction callback (falls back to defaultQueryResult)
 * @returns {Object} Mock database manager
 */
const createMockDbManager = (options = {}) => {
    const {
        defaultQueryResult = [],
        transactionQueryResult
    } = options;

    const txQuery = jest.fn().mockResolvedValue(
        transactionQueryResult === undefined ? defaultQueryResult : transactionQueryResult
    );
    const commit = jest.fn();
    const rollback = jest.fn();

    // Mirrors the real commit-on-resolve / rollback-and-rethrow contract so tests
    // can assert which way a transaction went.
    const withTransaction = jest.fn(async (fn) => {
        try {
            const result = await fn({ query: txQuery });
            commit();
            return result;
        } catch (error) {
            rollback();
            throw error;
        }
    });

    return {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(defaultQueryResult),
        withTransaction,
        close: jest.fn().mockResolvedValue(undefined),

        // Test-only handles - not part of the real interface.
        _transaction: { query: txQuery, commit, rollback }
    };
};

/**
 * Creates a mock database manager that fails every operation
 * @param {Error} error - The error to throw
 * @returns {Object} Mock database manager that rejects
 */
const createErrorDbManager = (error = new Error('Database error')) => {
    return {
        connect: jest.fn().mockRejectedValue(error),
        query: jest.fn().mockRejectedValue(error),
        withTransaction: jest.fn().mockRejectedValue(error),
        close: jest.fn().mockResolvedValue(undefined)
    };
};

module.exports = {
    createMockDbManager,
    createErrorDbManager
};
