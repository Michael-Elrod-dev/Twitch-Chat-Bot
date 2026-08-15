const Bot = require('../../src/bot');

jest.mock('../../src/database/dbBackupManager');
jest.mock('../../src/database/dbManager');
jest.mock('../../src/database/debugDbSetup');
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
jest.mock('../../src/websocket/webSocketManager');
jest.mock('../../src/websocket/subscriptionManager');
jest.mock('../../src/notifications/discordNotifier');
jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    channelName: 'testchannel',
    database: {
        host: 'localhost',
        port: 3306,
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    },
    discord: {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        notificationDelay: 30000
    },
    twitchChannelUrl: 'https://www.twitch.tv/testchannel',
    tokenRefreshInterval: 300000,
    viewerTrackingInterval: 60000,
    backupInterval: 3600000,
    shutdownGracePeriod: 1800000
}));

const DbBackupManager = require('../../src/database/dbBackupManager');
const DbManager = require('../../src/database/dbManager');
const DebugDbSetup = require('../../src/database/debugDbSetup');
const TokenManager = require('../../src/tokens/tokenManager');
const TwitchAPI = require('../../src/tokens/twitchAPI');
const CommandManager = require('../../src/commands/commandManager');
const AnalyticsManager = require('../../src/analytics/analyticsManager');
const config = require('../../src/config/config');

describe('Bot - Database Backup Integration', () => {
    let bot;
    let mockBackupManager;
    let mockDbManager;
    let mockTokenManager;
    let mockTwitchAPI;
    let mockCommandManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockBackupManager = {
            createBackup: jest.fn().mockResolvedValue(true),
            cleanup: jest.fn().mockResolvedValue(undefined)
        };
        DbBackupManager.mockImplementation(() => mockBackupManager);

        mockDbManager = {
            connect: jest.fn().mockResolvedValue(undefined),
            query: jest.fn().mockResolvedValue([]),
            close: jest.fn().mockResolvedValue(undefined)
        };
        DbManager.mockImplementation(() => mockDbManager);

        DebugDbSetup.mockImplementation(() => ({
            setupDebugDatabase: jest.fn().mockResolvedValue(undefined)
        }));

        mockTokenManager = {
            init: jest.fn().mockResolvedValue(undefined),
            checkAndRefreshTokens: jest.fn().mockResolvedValue(undefined),
            tokens: {
                channelId: 'channel-123',
                claudeApiKey: 'claude-key'
            }
        };
        TokenManager.mockImplementation(() => mockTokenManager);

        mockCommandManager = {
            init: jest.fn().mockResolvedValue(undefined),
            handleCommand: jest.fn().mockResolvedValue(undefined)
        };
        CommandManager.mockImplementation(() => mockCommandManager);
        CommandManager.createWithDependencies = jest.fn().mockReturnValue(mockCommandManager);

        mockTwitchAPI = {
            getStreamByUserName: jest.fn().mockResolvedValue(null),
            getChatters: jest.fn().mockResolvedValue([]),
            getChannelInfo: jest.fn().mockResolvedValue(null)
        };
        TwitchAPI.mockImplementation(() => mockTwitchAPI);

        // The automock leaves `viewerTracker` undefined, which makes
        // handleStreamOffline throw before it clears its intervals - leaking a real
        // 60s viewer-tracking interval and hanging Jest. Model the real shape instead.
        AnalyticsManager.mockImplementation(() => ({
            init: jest.fn().mockResolvedValue(undefined),
            trackStreamStart: jest.fn().mockResolvedValue(undefined),
            trackStreamEnd: jest.fn().mockResolvedValue(undefined),
            trackChatMessage: jest.fn().mockResolvedValue(undefined),
            viewerTracker: {
                endAllSessionsForStream: jest.fn().mockResolvedValue(undefined),
                processViewerList: jest.fn().mockResolvedValue(undefined)
            }
        }));

        bot = new Bot();
    });

    afterEach(() => {
        clearInterval(bot.viewerTrackingInterval);
        clearInterval(bot.backupInterval);
        clearTimeout(bot.shutdownTimer);
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize backup manager', () => {
            expect(bot.backupManager).toBe(mockBackupManager);
            expect(bot.backupInterval).toBeNull();
        });

        it('should create DbBackupManager instance', () => {
            expect(DbBackupManager).toHaveBeenCalled();
        });
    });

    describe('startDatabaseBackups', () => {
        beforeEach(async () => {
            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });
        });

        it('should create initial backup when starting', async () => {
            await bot.init();
            jest.runOnlyPendingTimers(); // Process initial backup promise

            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('stream-start');
        });

        it('should set up hourly backup interval', async () => {
            await bot.init();

            expect(bot.backupInterval).not.toBeNull();
        });

        it('should create scheduled backups every hour', async () => {
            await bot.init();
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('scheduled');
        });

        it('should skip backup if not streaming', async () => {
            await bot.init();
            bot.isStreaming = false;
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });

        it('should skip backup if shutting down', async () => {
            await bot.init();
            bot.isShuttingDown = true;
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });

        it('should not start backups in debug mode', async () => {
            config.isDebugMode = true;

            await bot.init();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
            expect(bot.backupInterval).toBeNull();

            config.isDebugMode = false; // Reset
        });

        it('should clear existing backup interval before starting new one', async () => {
            await bot.init();
            const firstInterval = bot.backupInterval;

            bot.startDatabaseBackups();
            const secondInterval = bot.backupInterval;

            expect(firstInterval).not.toBe(secondInterval);
        });
    });

    describe('handleStreamOffline - backup interval cleanup', () => {
        // Stays on the file-wide fake timers: under real timers bot.init() and the
        // offline transition create genuine long-lived intervals/timeouts that
        // outlive the test and keep the Jest process alive.
        beforeEach(async () => {
            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });
            await bot.init();
        });

        it('should clear backup interval when stream goes offline', async () => {
            expect(bot.backupInterval).toBeTruthy();

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
        });

        it('should not create backups after interval is cleared', async () => {
            await bot.handleStreamOffline();

            // Scoped to the hourly backup interval - cancel the auto-shutdown timer
            // the offline transition arms, whose expiry would take a final backup.
            clearTimeout(bot.shutdownTimer);
            bot.shutdownTimer = null;
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });
    });

    describe('gracefulShutdown - final backup', () => {
        beforeEach(async () => {
            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });

            jest.spyOn(process, 'exit').mockImplementation(() => {});
        });

        afterEach(() => {
            process.exit.mockRestore();
        });

        it('should create final backup before shutdown', async () => {
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test shutdown');

            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('shutdown');
        });

        it('should skip final backup in debug mode', async () => {
            config.isDebugMode = true;
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            config.isDebugMode = false;
        });

        it('should clear backup interval before creating final backup', async () => {
            await bot.init();
            expect(bot.backupInterval).not.toBeNull();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(bot.backupInterval).toBeNull();
        });

        it('should create final backup before closing database', async () => {
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            const backupCallOrder = mockBackupManager.createBackup.mock.invocationCallOrder[0];
            const dbCloseCallOrder = mockDbManager.close.mock.invocationCallOrder[0];

            expect(backupCallOrder).toBeLessThan(dbCloseCallOrder);
        });

        it('should close database even if backup fails', async () => {
            mockBackupManager.createBackup.mockRejectedValue(new Error('Backup failed'));
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(mockDbManager.close).toHaveBeenCalled();
        });

        it('should prevent duplicate shutdown calls from creating multiple backups', async () => {
            await bot.init();
            jest.clearAllMocks();

            const shutdown1 = bot.gracefulShutdown('test');
            const shutdown2 = bot.gracefulShutdown('test');

            await Promise.all([shutdown1, shutdown2]);

            expect(mockBackupManager.createBackup).toHaveBeenCalledTimes(1);
        });
    });

    describe('Integration scenarios', () => {
        beforeEach(() => {
            jest.spyOn(process, 'exit').mockImplementation(() => {});
        });

        afterEach(() => {
            process.exit.mockRestore();
        });

        it('should handle complete lifecycle: start -> backup -> shutdown', async () => {
            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });

            await bot.init();

            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('stream-start');

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();
            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('scheduled');

            await bot.gracefulShutdown('test');
            expect(mockBackupManager.createBackup).toHaveBeenCalledWith('shutdown');

            expect(mockBackupManager.createBackup).toHaveBeenCalledTimes(3);
        });

        it('should not create backups in debug mode throughout lifecycle', async () => {
            config.isDebugMode = true;

            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            await bot.init();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();
            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            await bot.gracefulShutdown('test');
            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            config.isDebugMode = false;
        });

        it('should stop scheduled backups when stream goes offline', async () => {
            // The real wrapper returns {startDate, viewer_count} - it has never had an id.
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ startDate: '2026-01-01T00:00:00Z', viewer_count: 12 });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });
            await bot.init();
            jest.clearAllMocks();

            await bot.handleStreamOffline();

            // The offline transition also arms the auto-shutdown timer, whose expiry
            // legitimately takes a final backup. Cancel it so this test stays scoped
            // to the hourly scheduled backup.
            clearTimeout(bot.shutdownTimer);
            bot.shutdownTimer = null;

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });
    });
});
