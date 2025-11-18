// tests/analytics/viewerTracker.test.js

const ViewerTracker = require('../../src/analytics/viewers/viewerTracker');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../../src/logger/logger');

describe('ViewerTracker', () => {
    let viewerTracker;
    let mockDbManager;
    let mockAnalyticsManager;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        mockAnalyticsManager = {
            dbManager: mockDbManager
        };

        viewerTracker = new ViewerTracker(mockAnalyticsManager);
    });

    afterEach(() => {
        jest.clearAllMocks();
        logger.info.mockClear();
        logger.debug.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
    });

    describe('ensureUserExists', () => {
        it('should insert new user with all properties', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const userId = await viewerTracker.ensureUserExists(
                'testuser',
                '123456',
                true,  // isMod
                false, // isSubscriber
                false  // isBroadcaster
            );

            expect(userId).toBe('123456');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT IGNORE INTO viewers'),
                ['123456', 'testuser', true, false, false, 'testuser', true, false, false]
            );
        });

        it('should use username as userId when userId is null', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const userId = await viewerTracker.ensureUserExists('testuser', null);

            expect(userId).toBe('testuser');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining(['testuser', 'testuser'])
            );
        });

        it('should update existing user on duplicate key', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.ensureUserExists('testuser', '123', false, true, false);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('ON DUPLICATE KEY UPDATE'),
                expect.anything()
            );
        });

        it('should handle database errors gracefully', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                viewerTracker.ensureUserExists('testuser', '123')
            ).rejects.toThrow('DB Error');
        });
    });

    describe('getActiveSession', () => {
        it('should return session_id when active session exists', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { session_id: 42 }
            ]);

            const sessionId = await viewerTracker.getActiveSession('user123', 'stream456');

            expect(sessionId).toBe(42);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE user_id = ? AND stream_id = ? AND end_time IS NULL'),
                ['user123', 'stream456']
            );
        });

        it('should return null when no active session exists', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const sessionId = await viewerTracker.getActiveSession('user123', 'stream456');

            expect(sessionId).toBeNull();
        });

        it('should return null on database error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const sessionId = await viewerTracker.getActiveSession('user123', 'stream456');

            expect(sessionId).toBeNull();
        });
    });

    describe('startSession', () => {
        it('should insert new viewing session', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.startSession('user123', 'stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO viewing_sessions'),
                ['user123', 'stream456']
            );
        });

        it('should handle database errors without throwing', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                viewerTracker.startSession('user123', 'stream456')
            ).resolves.toBeUndefined();
        });
    });

    describe('endSession', () => {
        it('should update session with end_time', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.endSession(42);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('SET end_time = NOW()'),
                [42]
            );
        });

        it('should handle database errors without throwing', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                viewerTracker.endSession(42)
            ).resolves.toBeUndefined();
        });
    });

    describe('endAllSessionsForStream', () => {
        it('should close all open sessions for stream', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.endAllSessionsForStream('stream456');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE stream_id = ? AND end_time IS NULL'),
                ['stream456']
            );
        });

        it('should log success message', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 5 });

            await viewerTracker.endAllSessionsForStream('stream456');

            expect(logger.info).toHaveBeenCalledWith(
                'ViewerTracker',
                'Closed all viewing sessions for stream',
                expect.objectContaining({
                    streamId: 'stream456'
                })
            );
        });
    });

    describe('processViewerList - Complex Session Logic', () => {
        it('should create sessions for new viewers', async () => {
            const viewers = [
                { user_id: '111', user_login: 'user1' },
                { user_id: '222', user_login: 'user2' }
            ];
            const streamId = 'stream123';

            mockDbManager.query
                .mockResolvedValueOnce([]) // user1 ensureUserExists
                .mockResolvedValueOnce([]) // user1 getActiveSession (no session)
                .mockResolvedValueOnce([]) // user1 startSession
                .mockResolvedValueOnce([]) // user2 ensureUserExists
                .mockResolvedValueOnce([]) // user2 getActiveSession (no session)
                .mockResolvedValueOnce([]) // user2 startSession
                .mockResolvedValueOnce([]); // Get active sessions (empty)

            await viewerTracker.processViewerList(viewers, streamId);

            const startSessionCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('INSERT INTO viewing_sessions')
            );
            expect(startSessionCalls).toHaveLength(2);
        });

        it('should not create duplicate sessions for existing viewers', async () => {
            const viewers = [
                { user_id: '111', user_login: 'user1' }
            ];
            const streamId = 'stream123';

            mockDbManager.query
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([{ session_id: 42 }]) // getActiveSession (has session)
                .mockResolvedValueOnce([]); // Get active sessions

            await viewerTracker.processViewerList(viewers, streamId);

            const startSessionCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('INSERT INTO viewing_sessions')
            );
            expect(startSessionCalls).toHaveLength(0);
        });

        it('should end sessions for viewers who left', async () => {
            const viewers = [
                { user_id: '111', user_login: 'user1' }
            ];
            const streamId = 'stream123';

            mockDbManager.query
                .mockResolvedValueOnce([]) // user1 ensureUserExists
                .mockResolvedValueOnce([{ session_id: 42 }]) // user1 has active session
                .mockResolvedValueOnce([ // Active sessions query
                    { session_id: 42, user_id: '111' },  // user1 (still watching)
                    { session_id: 43, user_id: '222' }   // user2 (left)
                ])
                .mockResolvedValueOnce([]); // endSession for user2

            await viewerTracker.processViewerList(viewers, streamId);

            const endSessionCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('SET end_time = NOW()') && call[1][0] === 43
            );
            expect(endSessionCalls).toHaveLength(1);
        });

        it('should handle empty viewer list', async () => {
            const viewers = [];
            const streamId = 'stream123';

            await viewerTracker.processViewerList(viewers, streamId);

            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should handle null viewer list', async () => {
            await viewerTracker.processViewerList(null, 'stream123');

            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should handle complex scenario: some stay, some leave, some join', async () => {
            const viewers = [
                { user_id: '111', user_login: 'user1' }, // Existing - stays
                { user_id: '333', user_login: 'user3' }  // New - joins
            ];
            const streamId = 'stream123';

            mockDbManager.query
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([{ session_id: 41 }]) // has session
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([]) // no session
                .mockResolvedValueOnce([]) // startSession
                .mockResolvedValueOnce([
                    { session_id: 41, user_id: '111' }, // user1 stays
                    { session_id: 42, user_id: '222' }  // user2 left
                ])
                .mockResolvedValueOnce([]); // endSession user2

            await viewerTracker.processViewerList(viewers, streamId);

            const startSessionCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('INSERT INTO viewing_sessions')
            );
            expect(startSessionCalls).toHaveLength(1);

            const endSessionCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('SET end_time = NOW()')
            );
            expect(endSessionCalls).toHaveLength(1);
        });
    });

    describe('trackInteraction', () => {
        it('should track chat message and update totals', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([{ count: 0 }]) // first message check
                .mockResolvedValueOnce([]) // update unique_chatters
                .mockResolvedValueOnce([]) // insert chat_messages
                .mockResolvedValueOnce([]); // updateChatTotals

            await viewerTracker.trackInteraction(
                'testuser',
                '123',
                'stream456',
                'message',
                'Hello world!',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO chat_messages'),
                expect.arrayContaining(['123', 'stream456', 'message', 'Hello world!'])
            );
        });

        it('should increment unique_chatters on first message', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([{ count: 0 }]) // first message
                .mockResolvedValueOnce([]) // update unique_chatters
                .mockResolvedValueOnce([]) // insert chat_messages
                .mockResolvedValueOnce([]); // updateChatTotals

            await viewerTracker.trackInteraction(
                'testuser',
                '123',
                'stream456',
                'message',
                'First!',
                {}
            );

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('SET unique_chatters = unique_chatters + 1'),
                ['stream456']
            );
        });

        it('should not increment unique_chatters on subsequent messages', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([]) // ensureUserExists
                .mockResolvedValueOnce([{ count: 5 }]) // not first message
                .mockResolvedValueOnce([]) // insert chat_messages
                .mockResolvedValueOnce([]); // updateChatTotals

            await viewerTracker.trackInteraction(
                'testuser',
                '123',
                'stream456',
                'message',
                'Another message',
                {}
            );

            const uniqueChatterCalls = mockDbManager.query.mock.calls.filter(
                call => call[0].includes('unique_chatters')
            );
            expect(uniqueChatterCalls).toHaveLength(0);
        });

        it('should handle undefined username gracefully', async () => {
            await viewerTracker.trackInteraction(
                undefined,
                '123',
                'stream456',
                'message',
                'test'
            );

            expect(logger.warn).toHaveBeenCalledWith(
                'ViewerTracker',
                'Attempted to track interaction for undefined username',
                expect.any(Object)
            );
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });
    });

    describe('updateChatTotals', () => {
        it('should increment message_count for message type', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.updateChatTotals('user123', 'message');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('message_count'),
                ['user123']
            );
        });

        it('should increment command_count for command type', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.updateChatTotals('user123', 'command');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('command_count'),
                ['user123']
            );
        });

        it('should increment redemption_count for redemption type', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.updateChatTotals('user123', 'redemption');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('redemption_count'),
                ['user123']
            );
        });

        it('should handle unknown message type', async () => {
            await viewerTracker.updateChatTotals('user123', 'invalid_type');

            expect(logger.error).toHaveBeenCalledWith(
                'ViewerTracker',
                expect.stringContaining('Unknown message type'),
                expect.objectContaining({
                    userId: 'user123',
                    messageType: 'invalid_type'
                })
            );
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });
    });

    describe('getUserStats', () => {
        it('should return aggregated stats for user', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([{ user_id: '123' }]) // getUserId
                .mockResolvedValueOnce([{ // getUserStats query
                    messages: 10,
                    commands: 5,
                    redemptions: 2
                }]);

            const stats = await viewerTracker.getUserStats('testuser');

            expect(stats).toEqual({
                messages: 10,
                commands: 5,
                redemptions: 2
            });
        });

        it('should return null when user not found', async () => {
            mockDbManager.query.mockResolvedValueOnce([]); // getUserId returns empty

            const stats = await viewerTracker.getUserStats('nonexistent');

            expect(stats).toBeNull();
        });

        it('should handle null values from database', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([{ user_id: '123' }])
                .mockResolvedValueOnce([{
                    messages: null,
                    commands: null,
                    redemptions: null
                }]);

            const stats = await viewerTracker.getUserStats('testuser');

            expect(stats).toEqual({
                messages: 0,
                commands: 0,
                redemptions: 0
            });
        });
    });

    describe('getTopUsers', () => {
        it('should return top users with default limit', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { username: 'user1', total: 100 },
                { username: 'user2', total: 50 },
                { username: 'user3', total: 25 }
            ]);

            const topUsers = await viewerTracker.getTopUsers();

            expect(topUsers).toEqual([
                '1. user1',
                '2. user2',
                '3. user3'
            ]);
        });

        it('should respect custom limit', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { username: 'user1', total: 100 }
            ]);

            await viewerTracker.getTopUsers(1);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('LIMIT 1')
            );
        });

        it('should handle invalid limit gracefully', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await viewerTracker.getTopUsers(-5);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('LIMIT 5')
            );
        });

        it('should return empty array on database error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const result = await viewerTracker.getTopUsers();

            expect(result).toEqual([]);
        });
    });
});
