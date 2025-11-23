// tests/bot/bot.discord.test.js

const Bot = require('../../src/bot');

jest.mock('../../src/config/config', () => ({
    channelName: 'testchannel',
    isDebugMode: false,
    discord: {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        notificationDelay: 100, // Short delay for testing
        notificationCooldown: 14400000 // 4 hours in milliseconds
    },
    twitchChannelUrl: 'https://www.twitch.tv/testchannel',
    database: {
        host: 'localhost',
        port: 3306,
        user: 'test',
        password: 'test',
        database: 'test_db'
    },
    shutdownGracePeriod: 1000
}));

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../src/database/dbManager');
jest.mock('../../src/database/dbBackupManager');
jest.mock('../../src/notifications/discordNotifier');

const config = require('../../src/config/config');
const logger = require('../../src/logger/logger');
const DiscordNotifier = require('../../src/notifications/discordNotifier');

describe('Bot - Discord Notification Integration', () => {
    let bot;
    let mockDiscordNotifier;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDiscordNotifier = {
            sendStreamLiveNotification: jest.fn().mockResolvedValue(true)
        };
        DiscordNotifier.mockImplementation(() => mockDiscordNotifier);

        bot = new Bot();
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    describe('constructor - Discord Notifier initialization', () => {
        it('should initialize Discord notifier with config values', () => {
            expect(DiscordNotifier).toHaveBeenCalledWith(
                'https://discord.com/api/webhooks/test/webhook',
                'https://www.twitch.tv/testchannel'
            );
            expect(bot.discordNotifier).toBe(mockDiscordNotifier);
        });
    });

    describe('handleStreamOnline', () => {
        beforeEach(() => {
            bot.startFullOperation = jest.fn().mockResolvedValue();
            bot.sendDiscordStreamNotification = jest.fn().mockResolvedValue();
            bot.shutdownTimer = null;
        });

        it('should schedule Discord notification after stream goes live', async () => {
            jest.useFakeTimers();

            await bot.handleStreamOnline();

            expect(bot.startFullOperation).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Scheduling Discord notification in 0.1 seconds'
            );
            expect(bot.sendDiscordStreamNotification).not.toHaveBeenCalled();

            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(bot.sendDiscordStreamNotification).toHaveBeenCalled();

            jest.useRealTimers();
        });

        it('should NOT schedule Discord notification in debug mode', async () => {
            config.isDebugMode = true;
            jest.useFakeTimers();

            await bot.handleStreamOnline();

            expect(bot.startFullOperation).toHaveBeenCalled();
            expect(bot.sendDiscordStreamNotification).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            expect(bot.sendDiscordStreamNotification).not.toHaveBeenCalled();

            config.isDebugMode = false;
            jest.useRealTimers();
        });

        it('should cancel shutdown timer when stream comes back online', async () => {
            bot.shutdownTimer = setTimeout(() => {}, 10000);
            const timerId = bot.shutdownTimer;

            await bot.handleStreamOnline();

            expect(bot.shutdownTimer).toBeNull();
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Stream came back online during grace period! Cancelling auto-shutdown'
            );
        });

        it('should handle error in Discord notification gracefully', async () => {
            jest.useFakeTimers();
            const notificationError = new Error('Discord API error');
            notificationError.stack = 'Error stack';
            bot.sendDiscordStreamNotification.mockRejectedValue(notificationError);

            await bot.handleStreamOnline();

            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(logger.error).toHaveBeenCalledWith(
                'Bot',
                'Error sending Discord notification',
                expect.objectContaining({
                    error: 'Discord API error',
                    stack: 'Error stack'
                })
            );

            jest.useRealTimers();
        });
    });

    describe('sendDiscordStreamNotification', () => {
        beforeEach(() => {
            bot.currentStreamId = 'test-stream-123';
            bot.dbManager = {
                query: jest.fn()
            };
        });

        it('should fetch stream data and send Discord notification', async () => {
            const mockStreamData = [
                {
                    title: 'Epic Gaming Stream',
                    category: 'Fortnite'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(bot.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('SELECT title, category'),
                ['test-stream-123']
            );
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Sending Discord notification',
                expect.objectContaining({
                    title: 'Epic Gaming Stream',
                    category: 'Fortnite'
                })
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'Epic Gaming Stream',
                'Fortnite'
            );
        });

        it('should handle null title in stream data', async () => {
            const mockStreamData = [
                {
                    title: null,
                    category: 'Just Chatting'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                null,
                'Just Chatting'
            );
        });

        it('should handle null category in stream data', async () => {
            const mockStreamData = [
                {
                    title: 'Test Stream',
                    category: null
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'Test Stream',
                null
            );
        });

        it('should warn when no stream data found in database', async () => {
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce([]); // No stream data

            await bot.sendDiscordStreamNotification();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'No stream data found in database for Discord notification',
                expect.objectContaining({
                    streamId: 'test-stream-123'
                })
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should return early when no currentStreamId', async () => {
            bot.currentStreamId = null;

            await bot.sendDiscordStreamNotification();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Cannot send Discord notification - no active stream or database'
            );
            expect(bot.dbManager.query).not.toHaveBeenCalled();
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should return early when no dbManager', async () => {
            bot.dbManager = null;

            await bot.sendDiscordStreamNotification();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Cannot send Discord notification - no active stream or database'
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should handle database query error', async () => {
            const dbError = new Error('Database connection failed');
            dbError.stack = 'Error stack';
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockRejectedValueOnce(dbError); // Query fails

            await bot.sendDiscordStreamNotification();

            expect(logger.error).toHaveBeenCalledWith(
                'Bot',
                'Failed to send Discord stream notification',
                expect.objectContaining({
                    error: 'Database connection failed',
                    stack: 'Error stack'
                })
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should handle Discord notifier error', async () => {
            const mockStreamData = [
                {
                    title: 'Test Stream',
                    category: 'Gaming'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData);

            const discordError = new Error('Discord webhook failed');
            discordError.stack = 'Error stack';
            mockDiscordNotifier.sendStreamLiveNotification.mockRejectedValue(discordError);

            await bot.sendDiscordStreamNotification();

            expect(logger.error).toHaveBeenCalledWith(
                'Bot',
                'Failed to send Discord stream notification',
                expect.objectContaining({
                    error: 'Discord webhook failed',
                    stack: 'Error stack'
                })
            );
        });

        it('should log debug message when fetching stream info', async () => {
            const mockStreamData = [
                {
                    title: 'Test Stream',
                    category: 'Gaming'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData);

            await bot.sendDiscordStreamNotification();

            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'Fetching stream information for Discord notification',
                expect.objectContaining({
                    streamId: 'test-stream-123'
                })
            );
        });

        it('should send notification on first run (no previous notification)', async () => {
            const mockStreamData = [
                {
                    title: 'First Stream',
                    category: 'Gaming'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'No previous Discord notification found, this is the first notification'
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'First Stream',
                'Gaming'
            );
            expect(bot.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tokens'),
                expect.arrayContaining(['lastDiscordNotification'])
            );
        });

        it('should skip notification when cooldown is active', async () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            bot.dbManager.query.mockResolvedValueOnce([
                { token_value: twoHoursAgo.toISOString() }
            ]);

            await bot.sendDiscordStreamNotification();

            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                'Discord notification cooldown active, skipping notification',
                expect.objectContaining({
                    lastNotificationTime: twoHoursAgo.toISOString(),
                    timeSinceLastNotification: expect.any(Number),
                    remainingMinutes: expect.any(Number)
                })
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should send notification when cooldown has passed', async () => {
            const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
            const mockStreamData = [
                {
                    title: 'After Cooldown Stream',
                    category: 'Gaming'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([{ token_value: fiveHoursAgo.toISOString() }])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'Cooldown period has passed, proceeding with notification',
                expect.objectContaining({
                    lastNotificationTime: fiveHoursAgo.toISOString(),
                    timeSinceLastNotification: expect.any(Number)
                })
            );
            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'After Cooldown Stream',
                'Gaming'
            );
        });

        it('should update timestamp after successful notification', async () => {
            const mockStreamData = [
                {
                    title: 'Test Stream',
                    category: 'Gaming'
                }
            ];
            const mockDate = new Date('2025-01-15T12:00:00.000Z');
            jest.spyOn(global, 'Date').mockImplementation(() => mockDate);

            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({}); // Timestamp update

            await bot.sendDiscordStreamNotification();

            expect(bot.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tokens'),
                [
                    'lastDiscordNotification',
                    mockDate.toISOString(),
                    mockDate.toISOString()
                ]
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'Bot',
                'Updated last Discord notification timestamp',
                expect.objectContaining({
                    timestamp: mockDate.toISOString()
                })
            );

            global.Date.mockRestore();
        });

        it('should not update timestamp if notification fails', async () => {
            const mockStreamData = [
                {
                    title: 'Test Stream',
                    category: 'Gaming'
                }
            ];
            const discordError = new Error('Discord webhook failed');
            mockDiscordNotifier.sendStreamLiveNotification.mockRejectedValue(discordError);

            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce(mockStreamData);

            await bot.sendDiscordStreamNotification();

            const updateCalls = bot.dbManager.query.mock.calls.filter(call =>
                call[0].includes('INSERT INTO tokens')
            );
            expect(updateCalls.length).toBe(0);
        });

        it('should not update timestamp if no stream data found', async () => {
            bot.dbManager.query
                .mockResolvedValueOnce([]) // No previous notification
                .mockResolvedValueOnce([]); // No stream data

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
            const updateCalls = bot.dbManager.query.mock.calls.filter(call =>
                call[0].includes('INSERT INTO tokens')
            );
            expect(updateCalls.length).toBe(0);
        });
    });

    describe('End-to-end stream online flow', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            bot.startFullOperation = jest.fn().mockResolvedValue();
            bot.currentStreamId = 'test-stream-456';
            bot.dbManager = {
                query: jest.fn()
                    .mockResolvedValueOnce([]) // No previous notification
                    .mockResolvedValueOnce([
                        {
                            title: 'End-to-End Test Stream',
                            category: 'Software Development'
                        }
                    ])
                    .mockResolvedValueOnce({}) // Timestamp update
            };
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should complete full notification flow when stream goes live', async () => {
            await bot.handleStreamOnline();

            expect(bot.startFullOperation).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'Bot',
                expect.stringContaining('Scheduling Discord notification')
            );

            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve(); // Extra tick for async operations

            expect(bot.dbManager.query).toHaveBeenCalled();
            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'End-to-End Test Stream',
                'Software Development'
            );
        });

        it('should not send notification if stream ends before delay expires', async () => {
            await bot.handleStreamOnline();

            bot.currentStreamId = null;

            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(logger.warn).toHaveBeenCalledWith(
                'Bot',
                'Cannot send Discord notification - no active stream or database'
            );
        });
    });
});
