// tests/messages/messageSender.test.js

const MessageSender = require('../../src/messages/messageSender');

// Mock node-fetch
jest.mock('node-fetch');

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

// Mock config
jest.mock('../../src/config/config', () => ({
    twitchApiEndpoint: 'https://api.twitch.tv/helix'
}));

const fetch = require('node-fetch');
const logger = require('../../src/logger/logger');

describe('MessageSender', () => {
    let messageSender;
    let mockTokenManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockTokenManager = {
            tokens: {
                channelId: '123456',
                botId: '789012',
                clientId: 'test-client-id',
                botAccessToken: 'test-bot-token'
            },
            validateToken: jest.fn().mockResolvedValue(true)
        };

        messageSender = new MessageSender(mockTokenManager);
    });

    describe('constructor', () => {
        it('should initialize with token manager', () => {
            expect(messageSender.tokenManager).toBe(mockTokenManager);
        });
    });

    describe('sendMessage', () => {
        it('should send message successfully', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await messageSender.sendMessage('testchannel', 'Hello, world!');

            expect(mockTokenManager.validateToken).toHaveBeenCalledWith('bot');
            expect(fetch).toHaveBeenCalledWith(
                'https://api.twitch.tv/helix/chat/messages',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Client-Id': 'test-client-id',
                        'Authorization': 'Bearer test-bot-token',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        broadcaster_id: '123456',
                        sender_id: '789012',
                        message: 'Hello, world!'
                    })
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'MessageSender',
                'Message sent successfully',
                expect.objectContaining({
                    channel: 'testchannel',
                    messageLength: 13
                })
            );
        });

        it('should log message preparation details', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await messageSender.sendMessage('testchannel', 'Test message');

            expect(logger.debug).toHaveBeenCalledWith(
                'MessageSender',
                'Preparing to send message',
                expect.objectContaining({
                    channel: 'testchannel',
                    messageLength: 12
                })
            );
        });

        it('should return early when channelId is missing', async () => {
            mockTokenManager.tokens.channelId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(mockTokenManager.validateToken).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Missing required IDs',
                expect.objectContaining({
                    channelId: null,
                    botId: '789012'
                })
            );
        });

        it('should return early when botId is missing', async () => {
            mockTokenManager.tokens.botId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(mockTokenManager.validateToken).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Missing required IDs',
                expect.objectContaining({
                    channelId: '123456',
                    botId: null
                })
            );
        });

        it('should return early when both IDs are missing', async () => {
            mockTokenManager.tokens.channelId = null;
            mockTokenManager.tokens.botId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(mockTokenManager.validateToken).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
        });

        it('should handle token validation failure', async () => {
            const tokenError = new Error('Token expired');
            tokenError.stack = 'Error stack';
            mockTokenManager.validateToken.mockRejectedValue(tokenError);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Token expired');

            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Error validating bot token',
                expect.objectContaining({
                    error: 'Token expired'
                })
            );
            expect(fetch).not.toHaveBeenCalled();
        });

        it('should handle API error response', async () => {
            const errorData = {
                error: 'Unauthorized',
                status: 401,
                message: 'Invalid OAuth token'
            };
            const mockResponse = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Failed to send chat message');

            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Failed to send chat message',
                expect.objectContaining({
                    statusCode: 401,
                    errorData: JSON.stringify(errorData)
                })
            );
        });

        it('should handle rate limit error (429)', async () => {
            const errorData = {
                error: 'Too Many Requests',
                status: 429,
                message: 'Rate limit exceeded'
            };
            const mockResponse = {
                ok: false,
                status: 429,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Failed to send chat message');

            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Failed to send chat message',
                expect.objectContaining({
                    statusCode: 429
                })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Network request failed');

            expect(logger.error).toHaveBeenCalledWith(
                'MessageSender',
                'Error sending chat message',
                expect.objectContaining({
                    error: 'Network request failed'
                })
            );
        });

        it('should handle fetch timeout', async () => {
            const timeoutError = new Error('Request timeout');
            timeoutError.code = 'ETIMEDOUT';
            fetch.mockRejectedValue(timeoutError);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Request timeout');
        });

        it('should send long messages', async () => {
            const longMessage = 'A'.repeat(500);
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await messageSender.sendMessage('testchannel', longMessage);

            expect(logger.info).toHaveBeenCalledWith(
                'MessageSender',
                'Message sent successfully',
                expect.objectContaining({
                    messageLength: 500
                })
            );
        });

        it('should handle empty message', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await messageSender.sendMessage('testchannel', '');

            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: expect.stringContaining('"message":""')
                })
            );
        });

        it('should handle special characters in message', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            const specialMessage = 'Test with "quotes" and emoji 😀';
            await messageSender.sendMessage('testchannel', specialMessage);

            const fetchCall = fetch.mock.calls[0][1];
            const body = JSON.parse(fetchCall.body);
            expect(body.message).toBe(specialMessage);
        });

        it('should handle malformed JSON response', async () => {
            const mockResponse = {
                ok: false,
                status: 500,
                json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Invalid JSON');
        });
    });

    describe('Integration scenarios', () => {
        it('should successfully send multiple messages in sequence', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValue(mockResponse);

            await messageSender.sendMessage('testchannel', 'Message 1');
            await messageSender.sendMessage('testchannel', 'Message 2');
            await messageSender.sendMessage('testchannel', 'Message 3');

            expect(fetch).toHaveBeenCalledTimes(3);
            expect(mockTokenManager.validateToken).toHaveBeenCalledTimes(3);
        });

        it('should handle alternating success and failure', async () => {
            const successResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            const errorResponse = {
                ok: false,
                status: 500,
                json: jest.fn().mockResolvedValue({ error: 'Server error' })
            };

            fetch
                .mockResolvedValueOnce(successResponse)
                .mockResolvedValueOnce(errorResponse)
                .mockResolvedValueOnce(successResponse);

            await messageSender.sendMessage('testchannel', 'Message 1');

            await expect(
                messageSender.sendMessage('testchannel', 'Message 2')
            ).rejects.toThrow();

            await messageSender.sendMessage('testchannel', 'Message 3');

            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });
});
