// tests/__mocks__/testHelpers.js

/**
 * Expects an async function to throw an error with a specific message
 * @param {Function} fn - Async function to test
 * @param {string|RegExp} errorMessage - Expected error message or pattern
 * @returns {Promise<Error>} The caught error for additional assertions
 */
const expectAsyncError = async (fn, errorMessage) => {
    let thrownError;
    try {
        await fn();
    } catch (error) {
        thrownError = error;
    }

    expect(thrownError).toBeDefined();

    if (errorMessage instanceof RegExp) {
        expect(thrownError.message).toMatch(errorMessage);
    } else {
        expect(thrownError.message).toContain(errorMessage);
    }

    return thrownError;
};

/**
 * Creates a mock Twitch context object
 * @param {Object} overrides - Properties to override
 * @returns {Object} Mock Twitch context
 */
const createMockContext = (overrides = {}) => {
    return {
        username: 'testuser',
        'user-id': 'user-123',
        'display-name': 'TestUser',
        mod: false,
        subscriber: false,
        badges: {},
        'badges-raw': '',
        color: '#FF0000',
        emotes: null,
        'emotes-raw': '',
        'first-msg': false,
        flags: '',
        id: 'message-id-123',
        'message-type': 'chat',
        'room-id': 'channel-id',
        'tmi-sent-ts': Date.now().toString(),
        turbo: false,
        'user-type': '',
        ...overrides
    };
};

/**
 * Creates a mock Twitch bot instance
 * @param {Object} overrides - Methods to override
 * @returns {Object} Mock Twitch bot
 */
const createMockTwitchBot = (overrides = {}) => {
    return {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        twitchAPI: {
            getCustomRewards: jest.fn(),
            updateCustomReward: jest.fn(),
            getStreamByUserName: jest.fn(),
            ...overrides.twitchAPI
        },
        viewerManager: overrides.viewerManager || {},
        analyticsManager: overrides.analyticsManager || {},
        emoteManager: overrides.emoteManager || {},
        ...overrides
    };
};

/**
 * Waits for a specified number of milliseconds
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Creates a mock EventEmitter-like object
 * @returns {Object} Mock event emitter
 */
const createMockEventEmitter = () => {
    const handlers = {};

    return {
        on: jest.fn((event, handler) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
        }),
        emit: jest.fn((event, ...args) => {
            if (handlers[event]) {
                handlers[event].forEach(handler => handler(...args));
            }
        }),
        removeListener: jest.fn((event, handler) => {
            if (handlers[event]) {
                handlers[event] = handlers[event].filter(h => h !== handler);
            }
        }),
        removeAllListeners: jest.fn((event) => {
            if (event) {
                delete handlers[event];
            } else {
                Object.keys(handlers).forEach(key => delete handlers[key]);
            }
        }),
        _handlers: handlers
    };
};

module.exports = {
    expectAsyncError,
    createMockContext,
    createMockTwitchBot,
    wait,
    createMockEventEmitter
};
