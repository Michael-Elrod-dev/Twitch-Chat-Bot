const MessageSender = require('../../src/messages/messageSender');

jest.mock('node-fetch');

jest.mock('../../src/config/config', () => ({
    twitchApiEndpoint: 'https://api.twitch.tv/helix'
}));

const fetch = require('node-fetch');

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
            validateToken: jest.fn().mockResolvedValue(true),
            refreshToken: jest.fn().mockResolvedValue('refreshed-bot-token')
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

            // No pre-flight /validate: that cost an API call plus a DB write per line.
            expect(mockTokenManager.validateToken).not.toHaveBeenCalled();
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
        });

        it('should return early when channelId is missing', async () => {
            mockTokenManager.tokens.channelId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(fetch).not.toHaveBeenCalled();
        });

        it('should return early when botId is missing', async () => {
            mockTokenManager.tokens.botId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(fetch).not.toHaveBeenCalled();
        });

        it('should return early when both IDs are missing', async () => {
            mockTokenManager.tokens.channelId = null;
            mockTokenManager.tokens.botId = null;

            await messageSender.sendMessage('testchannel', 'Test');

            expect(fetch).not.toHaveBeenCalled();
        });

        it('should handle API error response', async () => {
            const errorData = {
                error: 'Bad Request',
                status: 400,
                message: 'Invalid message'
            };
            const mockResponse = {
                ok: false,
                status: 400,
                json: jest.fn().mockResolvedValue(errorData)
            };
            fetch.mockResolvedValue(mockResponse);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Failed to send chat message');

            // Only a 401 warrants a refresh.
            expect(mockTokenManager.refreshToken).not.toHaveBeenCalled();
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
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Network request failed');
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

            expect(fetch).toHaveBeenCalled();
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

        it('should refresh once and retry when the send is rejected with 401', async () => {
            const unauthorized = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue({ message: 'Invalid OAuth token' })
            };
            const success = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(success);

            await messageSender.sendMessage('testchannel', 'Test');

            expect(mockTokenManager.refreshToken).toHaveBeenCalledWith('bot');
            expect(mockTokenManager.refreshToken).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it('should use the refreshed token on the retry', async () => {
            const unauthorized = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue({ message: 'Invalid OAuth token' })
            };
            const success = {
                ok: true,
                json: jest.fn().mockResolvedValue({ data: [] })
            };
            fetch.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(success);
            mockTokenManager.refreshToken.mockImplementation(async () => {
                mockTokenManager.tokens.botAccessToken = 'brand-new-token';
            });

            await messageSender.sendMessage('testchannel', 'Test');

            const retryHeaders = fetch.mock.calls[1][1].headers;
            expect(retryHeaders.Authorization).toBe('Bearer brand-new-token');
        });

        it('should retry only once when the 401 persists', async () => {
            const unauthorized = {
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue({ message: 'Invalid OAuth token' })
            };
            fetch.mockResolvedValue(unauthorized);

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Failed to send chat message');

            // Refresh-once-retry-once, never a loop.
            expect(mockTokenManager.refreshToken).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it('should surface a refresh failure during the 401 retry', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 401,
                json: jest.fn().mockResolvedValue({ message: 'Invalid OAuth token' })
            });
            mockTokenManager.refreshToken.mockRejectedValue(new Error('Refresh token dead'));

            await expect(
                messageSender.sendMessage('testchannel', 'Test')
            ).rejects.toThrow('Refresh token dead');

            expect(fetch).toHaveBeenCalledTimes(1);
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
            // One request per message - no validation round-trip riding along.
            expect(mockTokenManager.validateToken).not.toHaveBeenCalled();
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
