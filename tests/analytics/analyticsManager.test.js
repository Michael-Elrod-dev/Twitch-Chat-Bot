// tests/analytics/analyticsManager.test.js

const AnalyticsManager = require('../../src/analytics/analyticsManager');

jest.mock('../../src/analytics/viewers/viewerTracker');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const ViewerTracker = require('../../src/analytics/viewers/viewerTracker');
const logger = require('../../src/logger/logger');

describe('AnalyticsManager', () => {
    let analyticsManager;
    let mockDbManager;
    let mockViewerTracker;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = {
            query: jest.fn().mockResolvedValue({ affectedRows: 1 })
        };

        mockViewerTracker = {
            trackInteraction: jest.fn().mockResolvedValue(true),
            ensureUserExists: jest.fn().mockResolvedValue(true)
        };

        ViewerTracker.mockImplementation(() => mockViewerTracker);

        analyticsManager = new AnalyticsManager();
    });

    describe('constructor', () => {
        it('should initialize with null values', () => {
            expect(analyticsManager.dbManager).toBeNull();
            expect(analyticsManager.currentStreamId).toBeNull();
            expect(analyticsManager.viewerTracker).toBeNull();
        });
    });

    describe('init', () => {
        it('should initialize successfully with dbManager', async () => {
            await analyticsManager.init(mockDbManager);

            expect(analyticsManager.dbManager).toBe(mockDbManager);
            expect(analyticsManager.viewerTracker).toBe(mockViewerTracker);
            expect(ViewerTracker).toHaveBeenCalledWith(analyticsManager);
            expect(logger.info).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Analytics manager initialized successfully'
            );
        });

        it('should create ViewerTracker with correct reference', async () => {
            await analyticsManager.init(mockDbManager);

            expect(ViewerTracker).toHaveBeenCalledWith(analyticsManager);
        });

        it('should handle initialization error', async () => {
            const initError = new Error('Initialization failed');
            initError.stack = 'Error stack';
            ViewerTracker.mockImplementation(() => {
                throw initError;
            });

            await expect(analyticsManager.init(mockDbManager)).rejects.toThrow('Initialization failed');

            expect(logger.error).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Failed to initialize analytics manager',
                expect.objectContaining({
                    error: 'Initialization failed'
                })
            );
        });

        it('should allow re-initialization', async () => {
            await analyticsManager.init(mockDbManager);
            const firstTracker = analyticsManager.viewerTracker;

            const newMockDbManager = { query: jest.fn() };
            await analyticsManager.init(newMockDbManager);

            expect(analyticsManager.dbManager).toBe(newMockDbManager);
            expect(ViewerTracker).toHaveBeenCalledTimes(2);
        });
    });

    describe('trackChatMessage', () => {
        beforeEach(async () => {
            await analyticsManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should track message type interaction', async () => {
            const userContext = {
                isMod: false,
                isSubscriber: true,
                isVip: false,
                isBroadcaster: false
            };

            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Hello chat!',
                'message',
                userContext
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalledWith(
                'testuser',
                'user-123',
                'stream-456',
                'message',
                'Hello chat!',
                userContext
            );

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE streams'),
                ['stream-456']
            );

            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Chat message tracked',
                expect.objectContaining({
                    username: 'testuser',
                    userId: 'user-123',
                    streamId: 'stream-456',
                    type: 'message'
                })
            );
        });

        it('should track command type interaction', async () => {
            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                '!uptime',
                'command',
                {}
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalledWith(
                'testuser',
                'user-123',
                'stream-456',
                'command',
                '!uptime',
                {}
            );
        });

        it('should track redemption type interaction', async () => {
            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Song Request: Darude - Sandstorm',
                'redemption',
                {}
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalledWith(
                'testuser',
                'user-123',
                'stream-456',
                'redemption',
                'Song Request: Darude - Sandstorm',
                {}
            );
        });

        it('should not update stream when streamId is null', async () => {
            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                null,
                'Test message',
                'message',
                {}
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalled();
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should not update stream when streamId is undefined', async () => {
            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                undefined,
                'Test message',
                'message',
                {}
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalled();
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should handle viewerTracker error gracefully', async () => {
            const trackingError = new Error('Tracking failed');
            trackingError.stack = 'Error stack';
            mockViewerTracker.trackInteraction.mockRejectedValue(trackingError);

            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Test',
                'message',
                {}
            );

            expect(logger.error).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Error tracking chat message',
                expect.objectContaining({
                    error: 'Tracking failed',
                    username: 'testuser',
                    userId: 'user-123',
                    streamId: 'stream-456',
                    type: 'message'
                })
            );
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Database error');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Test',
                'message',
                {}
            );

            expect(logger.error).toHaveBeenCalled();
        });

        it('should not throw on error', async () => {
            mockViewerTracker.trackInteraction.mockRejectedValue(new Error('Test error'));

            await expect(
                analyticsManager.trackChatMessage('user', 'id', 'stream', 'msg', 'message', {})
            ).resolves.not.toThrow();
        });

        it('should handle empty userContext', async () => {
            await analyticsManager.trackChatMessage(
                'testuser',
                'user-123',
                'stream-456',
                'Test',
                'message',
                {}
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalledWith(
                'testuser',
                'user-123',
                'stream-456',
                'message',
                'Test',
                {}
            );
        });

        it('should handle complete userContext', async () => {
            const fullContext = {
                isMod: true,
                isSubscriber: true,
                isVip: false,
                isBroadcaster: false,
                badges: { moderator: '1', subscriber: '12' }
            };

            await analyticsManager.trackChatMessage(
                'moduser',
                'user-789',
                'stream-456',
                'Mod message',
                'message',
                fullContext
            );

            expect(mockViewerTracker.trackInteraction).toHaveBeenCalledWith(
                'moduser',
                'user-789',
                'stream-456',
                'message',
                'Mod message',
                fullContext
            );
        });
    });

    describe('trackStreamStart', () => {
        beforeEach(async () => {
            await analyticsManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should track stream start successfully', async () => {
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });

            await analyticsManager.trackStreamStart('stream-123', 'Test Stream', 'Just Chatting');

            expect(analyticsManager.currentStreamId).toBe('stream-123');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO streams'),
                ['stream-123', 'Test Stream', 'Just Chatting']
            );
            expect(logger.info).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Stream started',
                expect.objectContaining({
                    streamId: 'stream-123',
                    title: 'Test Stream',
                    category: 'Just Chatting'
                })
            );
        });

        it('should handle stream start with null category', async () => {
            await analyticsManager.trackStreamStart('stream-123', 'Test Stream', null);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['stream-123', 'Test Stream', null]
            );
        });

        it('should handle stream start with empty title', async () => {
            await analyticsManager.trackStreamStart('stream-123', '', 'Just Chatting');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['stream-123', '', 'Just Chatting']
            );
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Database insert failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            await analyticsManager.trackStreamStart('stream-123', 'Test', 'Category');

            expect(logger.error).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Error tracking stream start',
                expect.objectContaining({
                    error: 'Database insert failed',
                    streamId: 'stream-123',
                    title: 'Test',
                    category: 'Category'
                })
            );
        });

        it('should not throw on error', async () => {
            mockDbManager.query.mockRejectedValue(new Error('Test error'));

            await expect(
                analyticsManager.trackStreamStart('stream-123', 'Test', 'Category')
            ).resolves.not.toThrow();
        });

        it('should update currentStreamId even if database fails', async () => {
            mockDbManager.query.mockRejectedValue(new Error('DB error'));

            await analyticsManager.trackStreamStart('stream-123', 'Test', 'Category');

            expect(analyticsManager.currentStreamId).toBe('stream-123');
        });
    });

    describe('trackStreamEnd', () => {
        beforeEach(async () => {
            await analyticsManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should track stream end successfully', async () => {
            analyticsManager.currentStreamId = 'stream-123';
            mockDbManager.query.mockResolvedValue({ affectedRows: 1 });

            await analyticsManager.trackStreamEnd('stream-123');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE streams'),
                ['stream-123']
            );
            expect(analyticsManager.currentStreamId).toBeNull();
            expect(logger.info).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Stream ended',
                expect.objectContaining({
                    streamId: 'stream-123'
                })
            );
        });

        it('should set currentStreamId to null', async () => {
            analyticsManager.currentStreamId = 'stream-123';

            await analyticsManager.trackStreamEnd('stream-123');

            expect(analyticsManager.currentStreamId).toBeNull();
        });

        it('should handle database error gracefully', async () => {
            const dbError = new Error('Database update failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            await analyticsManager.trackStreamEnd('stream-123');

            expect(logger.error).toHaveBeenCalledWith(
                'AnalyticsManager',
                'Error tracking stream end',
                expect.objectContaining({
                    error: 'Database update failed',
                    streamId: 'stream-123'
                })
            );
        });

        it('should not throw on error', async () => {
            mockDbManager.query.mockRejectedValue(new Error('Test error'));

            await expect(
                analyticsManager.trackStreamEnd('stream-123')
            ).resolves.not.toThrow();
        });

        it('should NOT set currentStreamId to null on error', async () => {
            analyticsManager.currentStreamId = 'stream-123';
            mockDbManager.query.mockRejectedValue(new Error('DB error'));

            await analyticsManager.trackStreamEnd('stream-123');

            expect(analyticsManager.currentStreamId).toBe('stream-123');
        });
    });

    describe('Integration scenarios', () => {
        beforeEach(async () => {
            await analyticsManager.init(mockDbManager);
            jest.clearAllMocks();
        });

        it('should handle complete stream lifecycle', async () => {
            await analyticsManager.trackStreamStart('stream-123', 'Test Stream', 'Gaming');
            expect(analyticsManager.currentStreamId).toBe('stream-123');

            await analyticsManager.trackChatMessage('user1', 'id1', 'stream-123', 'msg1', 'message', {});
            await analyticsManager.trackChatMessage('user2', 'id2', 'stream-123', '!cmd', 'command', {});
            await analyticsManager.trackChatMessage('user3', 'id3', 'stream-123', 'redemption', 'redemption', {});

            await analyticsManager.trackStreamEnd('stream-123');
            expect(analyticsManager.currentStreamId).toBeNull();

            expect(mockDbManager.query).toHaveBeenCalledTimes(5); // 1 insert + 3 updates + 1 end
        });

        it('should handle multiple streams in sequence', async () => {
            await analyticsManager.trackStreamStart('stream-1', 'Stream 1', 'Category 1');
            await analyticsManager.trackStreamEnd('stream-1');

            await analyticsManager.trackStreamStart('stream-2', 'Stream 2', 'Category 2');
            await analyticsManager.trackStreamEnd('stream-2');

            expect(analyticsManager.currentStreamId).toBeNull();
            expect(mockDbManager.query).toHaveBeenCalledTimes(4);
        });

        it('should handle overlapping stream tracking', async () => {
            await analyticsManager.trackStreamStart('stream-1', 'Stream 1', 'Category 1');
            expect(analyticsManager.currentStreamId).toBe('stream-1');

            await analyticsManager.trackStreamStart('stream-2', 'Stream 2', 'Category 2');
            expect(analyticsManager.currentStreamId).toBe('stream-2');
        });
    });
});
