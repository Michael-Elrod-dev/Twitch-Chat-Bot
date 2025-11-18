// tests/bot/bot.backup.test.js


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
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));
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
const logger = require('../../src/logger/logger');
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

        bot = new Bot();
    });

    afterEach(() => {
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
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
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

        it('should log success when initial backup completes', async () => {
            mockBackupManager.createBackup.mockResolvedValue(true);

            await bot.init();
            jest.runOnlyPendingTimers();
            await Promise.resolve(); // Wait for promise

            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Initial database backup completed'
            );
        });

        it('should log warning when initial backup fails', async () => {
            mockBackupManager.createBackup.mockResolvedValue(false);

            await bot.init();
            jest.runOnlyPendingTimers();
            await Promise.resolve();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Initial database backup failed'
            );
        });

        it('should set up hourly backup interval', async () => {
            await bot.init();

            expect(bot.backupInterval).not.toBeNull();
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Database backup interval started',
                { intervalMs: 3600000 }
            );
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

        it('should log scheduled backup success', async () => {
            mockBackupManager.createBackup.mockResolvedValue(true);
            await bot.init();
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Scheduled database backup completed'
            );
        });

        it('should log scheduled backup failure', async () => {
            mockBackupManager.createBackup.mockResolvedValue(false);
            await bot.init();
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Scheduled database backup failed'
            );
        });

        it('should handle backup errors gracefully', async () => {
            const backupError = new Error('S3 connection failed');
            mockBackupManager.createBackup.mockRejectedValue(backupError);
            await bot.init();
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(logger.error).toHaveBeenCalledWith(
                'Bot',
                'Error in backup interval',
                expect.objectContaining({ error: 'S3 connection failed' })
            );
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
            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'Clearing existing backup interval'
            );
        });
    });

    describe('handleStreamOffline - backup interval cleanup', () => {
        beforeEach(async () => {
            jest.useRealTimers();

            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });
            await bot.init();
        });

        afterEach(() => {
            if (bot.backupInterval) {
                clearInterval(bot.backupInterval);
            }
            jest.useFakeTimers();
        });

        it('should clear backup interval when stream goes offline', async () => {
            expect(bot.backupInterval).toBeTruthy();

            await bot.handleStreamOffline();

            expect(bot.isStreaming).toBe(false);
        });

        it('should not create backups after interval is cleared', async () => {
            await bot.handleStreamOffline();
            jest.clearAllMocks();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });
    });

    describe('gracefulShutdown - final backup', () => {
        beforeEach(async () => {
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
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
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Creating final database backup before shutdown'
            );
        });

        it('should log success when final backup completes', async () => {
            mockBackupManager.createBackup.mockResolvedValue(true);
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Final database backup completed'
            );
        });

        it('should log warning when final backup fails', async () => {
            mockBackupManager.createBackup.mockResolvedValue(false);
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Final database backup failed'
            );
        });

        it('should handle backup error during shutdown', async () => {
            const backupError = new Error('Backup failed');
            mockBackupManager.createBackup.mockRejectedValue(backupError);
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(logger.error).toHaveBeenCalledWith(
                'Bot',
                'Error creating final backup',
                expect.objectContaining({ error: 'Backup failed' })
            );
        });

        it('should skip final backup in debug mode', async () => {
            config.isDebugMode = true;
            await bot.init();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
            expect(logger.info).not.toHaveBeenCalledWith(
                'Bot',
                'Creating final database backup before shutdown'
            );

            config.isDebugMode = false; // Reset
        });

        it('should clear backup interval before creating final backup', async () => {
            await bot.init();
            expect(bot.backupInterval).not.toBeNull();
            jest.clearAllMocks();

            await bot.gracefulShutdown('test');

            expect(bot.backupInterval).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'Clearing backup interval'
            );
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
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
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

            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
            await bot.init();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();
            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            await bot.gracefulShutdown('test');
            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();

            config.isDebugMode = false; // Reset
        });

        it('should stop scheduled backups when stream goes offline', async () => {
            mockTwitchAPI.getStreamByUserName.mockResolvedValue({ id: 'stream-123' });
            mockTwitchAPI.getChannelInfo.mockResolvedValue({
                title: 'Test Stream',
                game_name: 'Testing'
            });
            await bot.init();
            jest.clearAllMocks();

            await bot.handleStreamOffline();

            jest.advanceTimersByTime(3600000);
            await Promise.resolve();

            expect(mockBackupManager.createBackup).not.toHaveBeenCalled();
        });
    });
});
