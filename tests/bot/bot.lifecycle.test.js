const Bot = require('../../src/bot');

jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    channelName: 'testchannel',
    apiEnabled: false,
    database: {
        host: 'localhost',
        port: 3306,
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    },
    discord: {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        notificationDelay: 30000,
        notificationCooldown: 14400000
    },
    twitchChannelUrl: 'https://www.twitch.tv/testchannel',
    tokenRefreshInterval: 300000,
    viewerTrackingInterval: 60000,
    backupInterval: 3600000,
    shutdownGracePeriod: 1800000,
    analyticsQueue: {
        drainTimeoutMs: 30000
    }
}));

jest.mock('../../src/database/dbManager');
jest.mock('../../src/database/dbBackupManager');
jest.mock('../../src/database/debugDbSetup');
jest.mock('../../src/redis/redisManager');
jest.mock('../../src/tokens/tokenManager');
jest.mock('../../src/tokens/twitchAPI');
jest.mock('../../src/ai/aiManager');
jest.mock('../../src/emotes/emoteManager');
jest.mock('../../src/commands/commandManager');
jest.mock('../../src/analytics/analyticsManager');
jest.mock('../../src/redemptions/quotes/quoteManager');
jest.mock('../../src/redemptions/songs/spotifyManager');
jest.mock('../../src/redemptions/redemptionManager');
jest.mock('../../src/messages/messageSender');
jest.mock('../../src/messages/chatMessageHandler');
jest.mock('../../src/messages/redemptionHandler');
jest.mock('../../src/websocket/webSocketManager');
jest.mock('../../src/websocket/subscriptionManager');
jest.mock('../../src/notifications/discordNotifier');
jest.mock('../../src/services/songToggleService');
jest.mock('../../src/api/apiServer');

const config = require('../../src/config/config');

describe('Bot - Lifecycle', () => {
    let bot;

    /**
     * Puts the bot into the state startFullOperation would leave it in, without
     * running startFullOperation itself. Lets the transition methods be exercised
     * in isolation from the DI wiring.
     */
    const enterFullOperationState = (overrides = {}) => {
        bot.isStreaming = true;
        bot.currentStreamId = 'stream-abc';

        bot.viewerManager = {
            endAllSessionsForStream: jest.fn().mockResolvedValue(undefined),
            processViewerList: jest.fn().mockResolvedValue(undefined),
            handleFollowEvent: jest.fn().mockResolvedValue(true)
        };
        bot.analyticsManager = {
            trackStreamEnd: jest.fn().mockResolvedValue(undefined),
            trackChatMessage: jest.fn().mockResolvedValue(undefined)
        };
        bot.messageSender = {
            sendMessage: jest.fn().mockResolvedValue(undefined)
        };
        bot.webSocketManager = {
            onChatMessage: jest.fn(),
            onRedemption: jest.fn(),
            onFollow: jest.fn(),
            close: jest.fn()
        };
        bot.subscriptionManager = {
            unsubscribeFromChatEvents: jest.fn().mockResolvedValue(undefined),
            unsubscribeFromChannelPoints: jest.fn().mockResolvedValue(undefined)
        };
        bot.dbManager = {
            query: jest.fn().mockResolvedValue({ affectedRows: 0 }),
            close: jest.fn().mockResolvedValue(undefined)
        };

        bot.viewerTrackingInterval = setInterval(() => {}, 60000);
        bot.backupInterval = setInterval(() => {}, 3600000);

        Object.assign(bot, overrides);
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.spyOn(process, 'exit').mockImplementation(() => {});

        bot = new Bot();
    });

    afterEach(() => {
        clearInterval(bot.viewerTrackingInterval);
        clearInterval(bot.backupInterval);
        clearTimeout(bot.shutdownTimer);
        jest.useRealTimers();
        config.isDebugMode = false;
    });

    describe('handleStreamOffline', () => {
        it('should end viewing sessions and record the stream end', async () => {
            enterFullOperationState();
            const { viewerManager, analyticsManager } = bot;

            await bot.handleStreamOffline();

            expect(viewerManager.endAllSessionsForStream).toHaveBeenCalledWith('stream-abc');
            expect(analyticsManager.trackStreamEnd).toHaveBeenCalledWith('stream-abc');
            expect(bot.currentStreamId).toBeNull();
        });

        it('should end sessions before recording the stream end', async () => {
            enterFullOperationState();
            const { viewerManager, analyticsManager } = bot;

            await bot.handleStreamOffline();

            expect(viewerManager.endAllSessionsForStream.mock.invocationCallOrder[0])
                .toBeLessThan(analyticsManager.trackStreamEnd.mock.invocationCallOrder[0]);
        });

        it('should clear the viewer tracking and backup intervals', async () => {
            enterFullOperationState();

            await bot.handleStreamOffline();

            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.backupInterval).toBeNull();
        });

        it('should mark the bot as no longer streaming', async () => {
            enterFullOperationState();

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
        });

        it('should detach the chat and redemption handlers from the WebSocket', async () => {
            enterFullOperationState();
            const webSocketManager = bot.webSocketManager;

            await bot.handleStreamOffline();

            expect(webSocketManager.onChatMessage).toBeNull();
            expect(webSocketManager.onRedemption).toBeNull();
        });

        it('should unsubscribe from chat and channel point events', async () => {
            enterFullOperationState();
            const { subscriptionManager } = bot;

            await bot.handleStreamOffline();

            expect(subscriptionManager.unsubscribeFromChatEvents).toHaveBeenCalled();
            expect(subscriptionManager.unsubscribeFromChannelPoints).toHaveBeenCalled();
        });

        it('should announce going offline in chat', async () => {
            enterFullOperationState();
            const { messageSender } = bot;

            await bot.handleStreamOffline();

            expect(messageSender.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                expect.stringContaining('Bot going offline')
            );
        });

        it('should not announce when it was not streaming', async () => {
            enterFullOperationState({ isStreaming: false });
            const { messageSender } = bot;

            await bot.handleStreamOffline();

            expect(messageSender.sendMessage).not.toHaveBeenCalled();
        });

        it('should start the auto-shutdown timer', async () => {
            enterFullOperationState();

            expect(bot.shutdownTimer).toBeNull();

            await bot.handleStreamOffline();

            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should still start the shutdown timer when unsubscribing fails', async () => {
            enterFullOperationState();
            bot.subscriptionManager.unsubscribeFromChatEvents
                .mockRejectedValue(new Error('Twitch API down'));

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should still tear down when the chat announcement fails', async () => {
            enterFullOperationState();
            bot.messageSender.sendMessage.mockRejectedValue(new Error('send failed'));

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.backupInterval).toBeNull();
        });

        it('should not throw when there is no active stream session', async () => {
            enterFullOperationState({ currentStreamId: null });
            const { analyticsManager } = bot;

            await expect(bot.handleStreamOffline()).resolves.toBeUndefined();

            expect(analyticsManager.trackStreamEnd).not.toHaveBeenCalled();
            expect(bot.isStreaming).toBe(false);
        });
    });

    describe('handleStreamOnline', () => {
        beforeEach(() => {
            bot.startFullOperation = jest.fn().mockResolvedValue(undefined);
            bot.sendDiscordStreamNotification = jest.fn().mockResolvedValue(undefined);
        });

        it('should reach full operation', async () => {
            await bot.handleStreamOnline();

            expect(bot.startFullOperation).toHaveBeenCalled();
        });

        it('should cancel a pending auto-shutdown timer', async () => {
            bot.shutdownTimer = setTimeout(() => {}, 1800000);

            await bot.handleStreamOnline();

            expect(bot.shutdownTimer).toBeNull();
        });

        it('should not run the queued shutdown after coming back online', async () => {
            const gracefulShutdown = jest.spyOn(bot, 'gracefulShutdown')
                .mockResolvedValue(undefined);

            bot.isStreaming = false;
            bot.startShutdownTimer();

            await bot.handleStreamOnline();
            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).not.toHaveBeenCalled();
        });
    });

    describe('startShutdownTimer', () => {
        let gracefulShutdown;

        beforeEach(() => {
            gracefulShutdown = jest.spyOn(bot, 'gracefulShutdown')
                .mockResolvedValue(undefined);
            bot.isStreaming = false;
            bot.isShuttingDown = false;
        });

        it('should shut down once the grace period expires', () => {
            bot.startShutdownTimer();

            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).toHaveBeenCalledWith('Auto-shutdown after grace period');
        });

        it('should not shut down before the grace period expires', () => {
            bot.startShutdownTimer();

            jest.advanceTimersByTime(1799999);

            expect(gracefulShutdown).not.toHaveBeenCalled();
        });

        it('should not shut down if the stream resumed during the grace period', () => {
            bot.startShutdownTimer();

            bot.isStreaming = true;
            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).not.toHaveBeenCalled();
        });

        it('should not shut down if a shutdown is already underway', () => {
            bot.startShutdownTimer();

            bot.isShuttingDown = true;
            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).not.toHaveBeenCalled();
        });

        it('should replace an existing timer rather than stacking a second one', () => {
            bot.startShutdownTimer();
            bot.startShutdownTimer();

            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).toHaveBeenCalledTimes(1);
        });
    });

    describe('cleanupOrphanedSessions', () => {
        beforeEach(() => {
            bot.dbManager = {
                query: jest.fn().mockResolvedValue({ affectedRows: 0 })
            };
        });

        it('should close orphaned streams and viewing sessions', async () => {
            await bot.cleanupOrphanedSessions();

            expect(bot.dbManager.query).toHaveBeenCalledTimes(4);

            const statements = bot.dbManager.query.mock.calls.map(([sql]) => sql);
            // 1: streams that have chat data get their last message time.
            expect(statements[0]).toContain('UPDATE streams s');
            expect(statements[0]).toContain('MAX(message_time)');
            // 2: streams with no chat data fall back to now.
            expect(statements[1]).toContain('UPDATE streams');
            expect(statements[1]).toContain('NOW()');
            // 3: viewing sessions with chat data get that user's last message time.
            expect(statements[2]).toContain('UPDATE viewing_sessions vs');
            expect(statements[2]).toContain('MAX(message_time)');
            // 4: remaining sessions fall back to the stream end, then now.
            expect(statements[3]).toContain('UPDATE viewing_sessions vs');
            expect(statements[3]).toContain('COALESCE');
        });

        it('should only target rows with a null end_time', async () => {
            await bot.cleanupOrphanedSessions();

            const statements = bot.dbManager.query.mock.calls.map(([sql]) => sql);
            statements.forEach(sql => expect(sql).toContain('end_time IS NULL'));
        });

        it('should not throw when a cleanup query fails', async () => {
            bot.dbManager.query.mockRejectedValue(new Error('Table is locked'));

            await expect(bot.cleanupOrphanedSessions()).resolves.toBeUndefined();
        });

        it('should not throw when a later cleanup query fails', async () => {
            bot.dbManager.query
                .mockResolvedValueOnce({ affectedRows: 1 })
                .mockRejectedValueOnce(new Error('Deadlock'));

            await expect(bot.cleanupOrphanedSessions()).resolves.toBeUndefined();
        });
    });

    describe('handleFollow', () => {
        const followEvent = {
            user_id: '12345',
            user_name: 'newfollower',
            followed_at: '2026-01-15T12:00:00Z'
        };

        it('should record the follow against the viewer', async () => {
            enterFullOperationState();
            const { viewerManager } = bot;

            await bot.handleFollow(followEvent);

            expect(viewerManager.handleFollowEvent).toHaveBeenCalledWith(
                '12345',
                'newfollower',
                '2026-01-15T12:00:00Z'
            );
        });

        it('should no-op when the viewer manager is not initialized', async () => {
            bot.viewerManager = null;

            await expect(bot.handleFollow(followEvent)).resolves.toBeUndefined();
        });

        it('should not throw when recording the follow fails', async () => {
            enterFullOperationState();
            bot.viewerManager.handleFollowEvent.mockRejectedValue(new Error('DB down'));

            await expect(bot.handleFollow(followEvent)).resolves.toBeUndefined();
        });
    });

    describe('sendMessage', () => {
        it('should delegate to the message sender while streaming', async () => {
            enterFullOperationState();
            const { messageSender } = bot;

            await bot.sendMessage('testchannel', 'hello chat');

            expect(messageSender.sendMessage).toHaveBeenCalledWith('testchannel', 'hello chat');
        });

        it('should no-op when not streaming', async () => {
            enterFullOperationState({ isStreaming: false });
            const { messageSender } = bot;

            await bot.sendMessage('testchannel', 'hello chat');

            expect(messageSender.sendMessage).not.toHaveBeenCalled();
        });

        it('should no-op while shutting down', async () => {
            enterFullOperationState({ isShuttingDown: true });
            const { messageSender } = bot;

            await bot.sendMessage('testchannel', 'hello chat');

            expect(messageSender.sendMessage).not.toHaveBeenCalled();
        });

        it('should no-op when the message sender is not initialized', async () => {
            enterFullOperationState({ messageSender: null });

            await expect(bot.sendMessage('testchannel', 'hello chat')).resolves.toBeUndefined();
        });
    });

    describe('Offline to shutdown sequence', () => {
        it('should tear down, wait out the grace period, then shut down', async () => {
            const gracefulShutdown = jest.spyOn(bot, 'gracefulShutdown')
                .mockResolvedValue(undefined);
            enterFullOperationState();

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(gracefulShutdown).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).toHaveBeenCalledWith('Auto-shutdown after grace period');
        });

        it('should abort the shutdown when the stream returns during the grace period', async () => {
            const gracefulShutdown = jest.spyOn(bot, 'gracefulShutdown')
                .mockResolvedValue(undefined);
            bot.startFullOperation = jest.fn().mockResolvedValue(undefined);
            bot.sendDiscordStreamNotification = jest.fn().mockResolvedValue(undefined);
            enterFullOperationState();

            await bot.handleStreamOffline();
            jest.advanceTimersByTime(600000);

            await bot.handleStreamOnline();

            expect(bot.shutdownTimer).toBeNull();
            expect(bot.startFullOperation).toHaveBeenCalled();

            jest.advanceTimersByTime(1800000);

            expect(gracefulShutdown).not.toHaveBeenCalled();
        });
    });
});
