// tests/notifications/discordNotifier.test.js

const DiscordNotifier = require('../../src/notifications/discordNotifier');

jest.mock('node-fetch');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const fetch = require('node-fetch');
const logger = require('../../src/logger/logger');

describe('DiscordNotifier', () => {
    let discordNotifier;
    const mockWebhookUrl = 'https://discord.com/api/webhooks/123/abc';
    const mockTwitchUrl = 'https://www.twitch.tv/testchannel';

    beforeEach(() => {
        jest.clearAllMocks();
        discordNotifier = new DiscordNotifier(mockWebhookUrl, mockTwitchUrl);
    });

    describe('constructor', () => {
        it('should initialize with webhook URL and Twitch URL', () => {
            expect(discordNotifier.webhookUrl).toBe(mockWebhookUrl);
            expect(discordNotifier.twitchUrl).toBe(mockTwitchUrl);
        });

        it('should log debug message on initialization', () => {
            expect(logger.debug).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Discord notifier initialized',
                expect.objectContaining({
                    webhookConfigured: true,
                    twitchUrl: mockTwitchUrl
                })
            );
        });

        it('should handle missing webhook URL', () => {
            jest.clearAllMocks();
            const notifier = new DiscordNotifier(null, mockTwitchUrl);
            expect(notifier.webhookUrl).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Discord notifier initialized',
                expect.objectContaining({
                    webhookConfigured: false
                })
            );
        });
    });

    describe('sendStreamLiveNotification', () => {
        it('should send notification successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Epic Gaming Stream',
                'Just Chatting'
            );

            expect(result).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                mockWebhookUrl,
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Successfully sent stream live notification to Discord',
                expect.objectContaining({
                    title: 'Epic Gaming Stream',
                    category: 'Just Chatting'
                })
            );
        });

        it('should send notification with null title', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await discordNotifier.sendStreamLiveNotification(
                null,
                'Gaming'
            );

            expect(result).toBe(true);
            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);
            expect(body.content).toContain('Stream is Live!');
        });

        it('should send notification with null category', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                null
            );

            expect(result).toBe(true);
            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);
            expect(body.content).toContain('N/A');
        });

        it('should return false when webhook URL is not configured', async () => {
            const notifier = new DiscordNotifier(null, mockTwitchUrl);
            const result = await notifier.sendStreamLiveNotification('Test', 'Gaming');

            expect(result).toBe(false);
            expect(fetch).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Discord webhook URL not configured, skipping notification'
            );
        });

        it('should handle Discord API error response', async () => {
            const mockResponse = {
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                text: jest.fn().mockResolvedValue('Invalid payload')
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                'Gaming'
            );

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Failed to send Discord notification',
                expect.objectContaining({
                    status: 400,
                    statusText: 'Bad Request',
                    error: 'Invalid payload'
                })
            );
        });

        it('should handle rate limit error (429)', async () => {
            const mockResponse = {
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                text: jest.fn().mockResolvedValue('Rate limited')
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                'Gaming'
            );

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Failed to send Discord notification',
                expect.objectContaining({
                    status: 429
                })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                'Gaming'
            );

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Error sending Discord notification',
                expect.objectContaining({
                    error: 'Network request failed',
                    stack: 'Error stack'
                })
            );
        });

        it('should handle timeout error', async () => {
            const timeoutError = new Error('Request timeout');
            timeoutError.code = 'ETIMEDOUT';
            fetch.mockRejectedValue(timeoutError);

            const result = await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                'Gaming'
            );

            expect(result).toBe(false);
        });

        it('should send valid JSON payload', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            await discordNotifier.sendStreamLiveNotification(
                'Amazing Stream',
                'Fortnite'
            );

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);

            expect(body).toHaveProperty('content');
            expect(body.content).toContain('Amazing Stream');
            expect(body.content).toContain('Fortnite');
            expect(body.content).toContain(mockTwitchUrl);
        });

        it('should handle special characters in title and category', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            await discordNotifier.sendStreamLiveNotification(
                'Stream with "quotes" & special chars 🎮',
                'Grand Theft Auto V'
            );

            expect(fetch).toHaveBeenCalled();
            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);
            expect(body.content).toContain('Stream with "quotes" & special chars 🎮');
        });

        it('should log debug message before sending', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            await discordNotifier.sendStreamLiveNotification(
                'Test Stream',
                'Gaming'
            );

            expect(logger.debug).toHaveBeenCalledWith(
                'DiscordNotifier',
                'Sending stream live notification to Discord',
                expect.objectContaining({
                    title: 'Test Stream',
                    category: 'Gaming',
                    url: mockTwitchUrl
                })
            );
        });
    });

    describe('buildNotificationMessage', () => {
        it('should build message with title and category', () => {
            const message = discordNotifier.buildNotificationMessage(
                'Epic Stream',
                'League of Legends'
            );

            expect(message).toEqual({
                content: '@everyone\n\n' +
                         '**Epic Stream**\n\n' +
                         '**Playing:** League of Legends\n\n' +
                         `${mockTwitchUrl}`
            });
        });

        it('should handle null title', () => {
            const message = discordNotifier.buildNotificationMessage(
                null,
                'Gaming'
            );

            expect(message.content).toContain('@everyone');
            expect(message.content).toContain('Stream is Live!');
            expect(message.content).toContain('Gaming');
        });

        it('should handle null category', () => {
            const message = discordNotifier.buildNotificationMessage(
                'Test Stream',
                null
            );

            expect(message.content).toContain('@everyone');
            expect(message.content).toContain('Test Stream');
            expect(message.content).toContain('N/A');
        });

        it('should handle both null values', () => {
            const message = discordNotifier.buildNotificationMessage(null, null);

            expect(message.content).toContain('@everyone');
            expect(message.content).toContain('Stream is Live!');
            expect(message.content).toContain('N/A');
        });

        it('should always include @everyone ping', () => {
            const message = discordNotifier.buildNotificationMessage(
                'Test',
                'Gaming'
            );

            expect(message.content.startsWith('@everyone')).toBe(true);
        });

        it('should always include Twitch URL', () => {
            const message = discordNotifier.buildNotificationMessage(
                'Test',
                'Gaming'
            );

            expect(message.content).toContain(mockTwitchUrl);
        });
    });

    describe('Integration scenarios', () => {
        it('should successfully send multiple notifications', async () => {
            const mockResponse = {
                ok: true,
                status: 204
            };
            fetch.mockResolvedValue(mockResponse);

            const result1 = await discordNotifier.sendStreamLiveNotification('Stream 1', 'Game 1');
            const result2 = await discordNotifier.sendStreamLiveNotification('Stream 2', 'Game 2');
            const result3 = await discordNotifier.sendStreamLiveNotification('Stream 3', 'Game 3');

            expect(result1).toBe(true);
            expect(result2).toBe(true);
            expect(result3).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it('should handle alternating success and failure', async () => {
            const successResponse = {
                ok: true,
                status: 204
            };
            const errorResponse = {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: jest.fn().mockResolvedValue('Server error')
            };

            fetch
                .mockResolvedValueOnce(successResponse)
                .mockResolvedValueOnce(errorResponse)
                .mockResolvedValueOnce(successResponse);

            const result1 = await discordNotifier.sendStreamLiveNotification('Stream 1', 'Game 1');
            const result2 = await discordNotifier.sendStreamLiveNotification('Stream 2', 'Game 2');
            const result3 = await discordNotifier.sendStreamLiveNotification('Stream 3', 'Game 3');

            expect(result1).toBe(true);
            expect(result2).toBe(false);
            expect(result3).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });
});
