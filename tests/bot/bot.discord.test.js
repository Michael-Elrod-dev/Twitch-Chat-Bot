// tests/bot/bot.discord.test.js

const Bot = require('../../src/bot');

jest.mock('../../src/config/config', () => ({
    channelName: 'testchannel',
    isDebugMode: false,
    discord: {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        notificationDelay: 100,
        notificationCooldown: 14400000
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

jest.mock('../../src/database/dbManager');
jest.mock('../../src/database/dbBackupManager');
jest.mock('../../src/notifications/discordNotifier');

const config = require('../../src/config/config');
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
            jest.useFakeTimers();
            bot.shutdownTimer = setTimeout(() => {}, 10000);

            await bot.handleStreamOnline();

            expect(bot.shutdownTimer).toBeNull();
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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({});

            await bot.sendDiscordStreamNotification();

            expect(bot.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('SELECT title, category'),
                ['test-stream-123']
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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({});

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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({});

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).toHaveBeenCalledWith(
                'Test Stream',
                null
            );
        });

        it('should not send when no stream data found in database', async () => {
            bot.dbManager.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should return early when no currentStreamId', async () => {
            bot.currentStreamId = null;

            await bot.sendDiscordStreamNotification();

            expect(bot.dbManager.query).not.toHaveBeenCalled();
            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should return early when no dbManager', async () => {
            bot.dbManager = null;

            await bot.sendDiscordStreamNotification();

            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });

        it('should handle database query error', async () => {
            const dbError = new Error('Database connection failed');
            dbError.stack = 'Error stack';
            bot.dbManager.query
                .mockResolvedValueOnce([])
                .mockRejectedValueOnce(dbError);

            await bot.sendDiscordStreamNotification();

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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData);

            const discordError = new Error('Discord webhook failed');
            discordError.stack = 'Error stack';
            mockDiscordNotifier.sendStreamLiveNotification.mockRejectedValue(discordError);

            await bot.sendDiscordStreamNotification();
        });

        it('should send notification on first run (no previous notification)', async () => {
            const mockStreamData = [
                {
                    title: 'First Stream',
                    category: 'Gaming'
                }
            ];
            bot.dbManager.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({});

            await bot.sendDiscordStreamNotification();

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
                .mockResolvedValueOnce({});

            await bot.sendDiscordStreamNotification();

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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData)
                .mockResolvedValueOnce({});

            await bot.sendDiscordStreamNotification();

            expect(bot.dbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tokens'),
                [
                    'lastDiscordNotification',
                    mockDate.toISOString(),
                    mockDate.toISOString()
                ]
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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(mockStreamData);

            await bot.sendDiscordStreamNotification();

            const updateCalls = bot.dbManager.query.mock.calls.filter(call =>
                call[0].includes('INSERT INTO tokens')
            );
            expect(updateCalls.length).toBe(0);
        });

        it('should not update timestamp if no stream data found', async () => {
            bot.dbManager.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

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
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([
                        {
                            title: 'End-to-End Test Stream',
                            category: 'Software Development'
                        }
                    ])
                    .mockResolvedValueOnce({})
            };
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should complete full notification flow when stream goes live', async () => {
            await bot.handleStreamOnline();

            expect(bot.startFullOperation).toHaveBeenCalled();

            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();

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

            expect(mockDiscordNotifier.sendStreamLiveNotification).not.toHaveBeenCalled();
        });
    });
});
