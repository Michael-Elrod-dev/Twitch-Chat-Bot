/**
 * P1-1 through P1-4: the analytics write path.
 *
 * Each describe reproduces the original defect's conditions and asserts the
 * corrected behaviour, so a regression fails here rather than silently corrupting
 * viewer data over a stream.
 */

const ViewerTracker = require('../../src/analytics/viewers/viewerTracker');

describe('ViewerTracker - P1 correctness', () => {
    let viewerTracker;
    let mockDbManager;
    let mockAnalyticsManager;
    let mockQueueManager;
    let mockRedisManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = {
            query: jest.fn().mockResolvedValue([{ count: 0 }])
        };
        mockAnalyticsManager = { dbManager: mockDbManager };

        mockQueueManager = {
            push: jest.fn().mockResolvedValue(true)
        };
        mockRedisManager = {
            connected: jest.fn().mockReturnValue(true),
            getQueueManager: jest.fn(() => mockQueueManager)
        };

        viewerTracker = new ViewerTracker(mockAnalyticsManager, mockRedisManager);
    });

    const sqlFor = (fragment) =>
        mockDbManager.query.mock.calls.find(([sql]) => sql.includes(fragment));

    describe('P1-1: role flags survive the viewer poll', () => {
        it('should write role columns from the chat path', async () => {
            await viewerTracker.ensureUserExists('mod_user', '123', true, false, true, false);

            const [sql, params] = sqlFor('INSERT INTO viewers');
            expect(sql).toContain('is_moderator = VALUES(is_moderator)');
            expect(params).toEqual(['123', 'mod_user', true, false, true, false]);
        });

        it('should NOT touch role columns from the poll path', async () => {
            await viewerTracker.touchUserPresence('mod_user', '123');

            const [sql, params] = sqlFor('INSERT INTO viewers');
            expect(sql).not.toContain('is_moderator');
            expect(sql).not.toContain('is_vip');
            expect(sql).not.toContain('is_subscriber');
            expect(sql).not.toContain('is_broadcaster');
            expect(params).toEqual(['123', 'mod_user']);
        });

        it('should use the presence-only path for every polled viewer', async () => {
            const touchSpy = jest.spyOn(viewerTracker, 'touchUserPresence');
            const ensureSpy = jest.spyOn(viewerTracker, 'ensureUserExists');
            mockDbManager.query.mockResolvedValue([]);

            await viewerTracker.processViewerList([
                { user_id: '1', user_login: 'alice' },
                { user_id: '2', user_login: 'bob' }
            ], 'stream-1');

            // The 60s poll carries no role data; calling the role-writing path with
            // defaults reset every flag the chat path had set.
            expect(touchSpy).toHaveBeenCalledTimes(2);
            expect(ensureSpy).not.toHaveBeenCalled();
        });

        it('should not use the contradictory INSERT IGNORE + ON DUPLICATE form', async () => {
            await viewerTracker.ensureUserExists('user', '123', true, false, false, false);

            const [sql] = sqlFor('INSERT INTO viewers');
            expect(sql).not.toContain('INSERT IGNORE');
            expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        });
    });

    describe('P1-4: no username-as-userId fallback', () => {
        it('should refuse the chat-path write when the id is missing', async () => {
            const result = await viewerTracker.ensureUserExists('testuser', null);

            expect(result).toBeNull();
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should refuse the poll-path write when the id is missing', async () => {
            const result = await viewerTracker.touchUserPresence('testuser', undefined);

            expect(result).toBeNull();
            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should abandon the interaction rather than write a bad id', async () => {
            await viewerTracker.trackInteraction('testuser', null, 'stream-1', 'message', 'hi');

            expect(mockDbManager.query).not.toHaveBeenCalled();
            expect(mockQueueManager.push).not.toHaveBeenCalled();
        });
    });

    describe('P1-2: per-write queue fallback', () => {
        const track = () =>
            viewerTracker.trackInteraction('testuser', '123', 'stream-1', 'message', 'hello');

        it('should write neither directly when both pushes succeed', async () => {
            await track();

            const inserts = mockDbManager.query.mock.calls
                .filter(([sql]) => sql.includes('INSERT INTO chat_messages'));
            expect(inserts).toHaveLength(0);
            expect(mockQueueManager.push).toHaveBeenCalledTimes(2);
        });

        it('should replay ONLY the message when the message push fails', async () => {
            mockQueueManager.push
                .mockResolvedValueOnce(false)  // chat_messages
                .mockResolvedValueOnce(true);  // chat_totals

            await track();

            expect(sqlFor('INSERT INTO chat_messages')).toBeDefined();
            // Replaying the totals here double-counted a write that was safely queued.
            expect(sqlFor('INSERT INTO chat_totals')).toBeUndefined();
        });

        it('should replay ONLY the totals when the totals push fails', async () => {
            mockQueueManager.push
                .mockResolvedValueOnce(true)   // chat_messages
                .mockResolvedValueOnce(false); // chat_totals

            await track();

            expect(sqlFor('INSERT INTO chat_messages')).toBeUndefined();
            expect(sqlFor('INSERT INTO chat_totals')).toBeDefined();
        });

        it('should write both directly when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            await track();

            expect(sqlFor('INSERT INTO chat_messages')).toBeDefined();
            expect(sqlFor('INSERT INTO chat_totals')).toBeDefined();
        });
    });

    describe('P1-3: unique-chatter inflation', () => {
        const burst = async (count) => {
            for (let i = 0; i < count; i++) {
                await viewerTracker.trackInteraction('spammer', '123', 'stream-1', 'message', `m${i}`);
            }
        };

        const uniqueIncrements = () =>
            mockDbManager.query.mock.calls
                .filter(([sql]) => sql.includes('unique_chatters = unique_chatters + 1'));

        it('should count a burst of first messages exactly once', async () => {
            // The DB COUNT(*) races the 5s batch flush: every message in the opening
            // burst saw zero rows and incremented.
            mockDbManager.query.mockResolvedValue([{ count: 0 }]);

            await burst(5);

            expect(uniqueIncrements()).toHaveLength(1);
        });

        it('should consult the DB only for the first sighting', async () => {
            mockDbManager.query.mockResolvedValue([{ count: 0 }]);

            await burst(4);

            const countChecks = mockDbManager.query.mock.calls
                .filter(([sql]) => sql.includes('SELECT COUNT(*) as count FROM chat_messages'));
            expect(countChecks).toHaveLength(1);
        });

        it('should not count a user who already has rows this stream', async () => {
            mockDbManager.query.mockResolvedValue([{ count: 7 }]);

            await burst(3);

            expect(uniqueIncrements()).toHaveLength(0);
        });

        it('should track streams independently', async () => {
            mockDbManager.query.mockResolvedValue([{ count: 0 }]);

            await viewerTracker.trackInteraction('u', '123', 'stream-1', 'message', 'a');
            await viewerTracker.trackInteraction('u', '123', 'stream-2', 'message', 'b');

            expect(uniqueIncrements()).toHaveLength(2);
        });

        it('should forget a stream when its sessions are closed', async () => {
            mockDbManager.query.mockResolvedValue([{ count: 0 }]);
            await viewerTracker.trackInteraction('u', '123', 'stream-1', 'message', 'a');

            await viewerTracker.endAllSessionsForStream('stream-1');

            expect(viewerTracker.seenChattersByStream.has('stream-1')).toBe(false);
        });

        it('should not grow unbounded across many streams once they end', async () => {
            mockDbManager.query.mockResolvedValue([{ count: 0 }]);

            for (let i = 0; i < 10; i++) {
                await viewerTracker.trackInteraction('u', '123', `stream-${i}`, 'message', 'a');
                await viewerTracker.endAllSessionsForStream(`stream-${i}`);
            }

            expect(viewerTracker.seenChattersByStream.size).toBe(0);
        });
    });
});
