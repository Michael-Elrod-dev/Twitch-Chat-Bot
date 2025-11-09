// tests/ai/claudeModel.test.js

const ClaudeModel = require('../../src/ai/models/claudeModel');

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
    claudeApiEndpoint: 'https://api.anthropic.com/v1',
    aiModels: {
        claude: {
            model: 'claude-3-5-sonnet-20241022',
            apiVersion: '2023-06-01',
            maxTokens: 1024,
            temperature: 1.0
        }
    },
    aiSettings: {
        claude: {
            systemPrompt: 'You are a helpful Twitch chat bot.'
        }
    }
}));

const fetch = require('node-fetch');
const logger = require('../../src/logger/logger');

describe('ClaudeModel', () => {
    let claudeModel;
    const mockApiKey = 'test-api-key-12345';

    beforeEach(() => {
        jest.clearAllMocks();
        claudeModel = new ClaudeModel(mockApiKey);
    });

    describe('constructor', () => {
        it('should initialize with API key', () => {
            expect(claudeModel.apiKey).toBe(mockApiKey);
        });
    });

    describe('getTextResponse', () => {
        it('should return successful response', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: '  Test response  ' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test prompt');

            expect(fetch).toHaveBeenCalledWith(
                'https://api.anthropic.com/v1/messages',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'x-api-key': mockApiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    },
                    body: expect.stringContaining('"model":"claude-3-5-sonnet-20241022"')
                })
            );

            expect(result).toBe('Test response');
        });

        it('should trim whitespace from response', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: '\n\n  Response with whitespace  \n\n' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBe('Response with whitespace');
        });

        it('should pass prompt in request body', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Custom prompt');

            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: expect.stringContaining('"content":"Custom prompt"')
                })
            );
        });

        it('should include model configuration', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test');

            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: expect.stringContaining('"max_tokens":1024')
                })
            );

            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: expect.stringContaining('"temperature":1')
                })
            );
        });

        it('should include system prompt', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test');

            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: expect.stringContaining('You are a helpful Twitch chat bot.')
                })
            );
        });

        it('should pass user context to logs', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test', { userName: 'testuser' });

            expect(logger.debug).toHaveBeenCalledWith(
                'ClaudeModel',
                'Sending request to Claude API',
                expect.objectContaining({
                    userName: 'testuser'
                })
            );
        });

        it('should log prompt length', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const longPrompt = 'A'.repeat(500);
            await claudeModel.getTextResponse(longPrompt);

            expect(logger.debug).toHaveBeenCalledWith(
                'ClaudeModel',
                'Sending request to Claude API',
                expect.objectContaining({
                    promptLength: 500
                })
            );
        });

        it('should log response details on success', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Short response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test');

            expect(logger.info).toHaveBeenCalledWith(
                'ClaudeModel',
                'Successfully received Claude API response',
                expect.objectContaining({
                    promptLength: 4,
                    responseLength: 14,
                    responseTime: expect.any(Number)
                })
            );
        });

        it('should handle API error response', async () => {
            const mockResponse = {
                ok: false,
                json: jest.fn().mockResolvedValue({
                    error: {
                        message: 'Invalid API key'
                    }
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'ClaudeModel',
                'Error getting Claude response',
                expect.objectContaining({
                    error: 'Claude API error: Invalid API key'
                })
            );
        });

        it('should handle API error without message', async () => {
            const mockResponse = {
                ok: false,
                json: jest.fn().mockResolvedValue({
                    error: {}
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'ClaudeModel',
                'Error getting Claude response',
                expect.objectContaining({
                    error: 'Claude API error: Unknown error'
                })
            );
        });

        it('should handle network error', async () => {
            const networkError = new Error('Network request failed');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'ClaudeModel',
                'Error getting Claude response',
                expect.objectContaining({
                    error: 'Network request failed'
                })
            );
        });

        it('should handle timeout error', async () => {
            const timeoutError = new Error('Request timeout');
            timeoutError.code = 'ETIMEDOUT';
            fetch.mockRejectedValue(timeoutError);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
        });

        it('should handle JSON parsing error', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalled();
        });

        it('should handle malformed response structure', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: []
                })
            };
            fetch.mockResolvedValue(mockResponse);

            // The code will crash trying to access content[0].text
            // But it's wrapped in a try-catch, so it returns null
            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalled();
        });

        it('should handle rate limit error (429)', async () => {
            const mockResponse = {
                ok: false,
                json: jest.fn().mockResolvedValue({
                    error: {
                        type: 'rate_limit_error',
                        message: 'Rate limit exceeded'
                    }
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'ClaudeModel',
                'Error getting Claude response',
                expect.objectContaining({
                    error: 'Claude API error: Rate limit exceeded'
                })
            );
        });

        it('should handle overloaded error (529)', async () => {
            const mockResponse = {
                ok: false,
                json: jest.fn().mockResolvedValue({
                    error: {
                        type: 'overloaded_error',
                        message: 'Service temporarily overloaded'
                    }
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('Test');

            expect(result).toBeNull();
        });

        it('should log response time on error', async () => {
            const networkError = new Error('Network error');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            await claudeModel.getTextResponse('Test');

            expect(logger.error).toHaveBeenCalledWith(
                'ClaudeModel',
                'Error getting Claude response',
                expect.objectContaining({
                    responseTime: expect.any(Number)
                })
            );
        });

        it('should handle empty prompt', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response to empty prompt' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse('');

            expect(result).toBe('Response to empty prompt');
        });

        it('should handle very long prompt', async () => {
            const longPrompt = 'A'.repeat(10000);
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse(longPrompt);

            expect(result).toBe('Response');
            expect(logger.debug).toHaveBeenCalledWith(
                'ClaudeModel',
                'Sending request to Claude API',
                expect.objectContaining({
                    promptLength: 10000
                })
            );
        });

        it('should handle special characters in prompt', async () => {
            const specialPrompt = 'Test with "quotes" and \\backslashes\\ and 😀 emoji';
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await claudeModel.getTextResponse(specialPrompt);

            expect(result).toBe('Response');
        });

        it('should handle context without userName', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test', {});

            expect(logger.debug).toHaveBeenCalledWith(
                'ClaudeModel',
                'Sending request to Claude API',
                expect.objectContaining({
                    userName: undefined
                })
            );
        });

        it('should measure response time accurately', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Test');

            const logCall = logger.info.mock.calls[0][2];
            expect(logCall.responseTime).toBeGreaterThanOrEqual(0);
            expect(logCall.responseTime).toBeLessThan(1000); // Should be fast in tests
        });

        it('should not throw on any error', async () => {
            fetch.mockRejectedValue(new Error('Unexpected error'));

            await expect(claudeModel.getTextResponse('Test')).resolves.not.toThrow();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple requests in sequence', async () => {
            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Response' }]
                })
            };
            fetch.mockResolvedValue(mockResponse);

            await claudeModel.getTextResponse('Request 1');
            await claudeModel.getTextResponse('Request 2');
            await claudeModel.getTextResponse('Request 3');

            expect(fetch).toHaveBeenCalledTimes(3);
        });

        it('should handle alternating success and failure', async () => {
            const successResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    content: [{ text: 'Success' }]
                })
            };
            const errorResponse = {
                ok: false,
                json: jest.fn().mockResolvedValue({
                    error: { message: 'Error' }
                })
            };

            fetch
                .mockResolvedValueOnce(successResponse)
                .mockResolvedValueOnce(errorResponse)
                .mockResolvedValueOnce(successResponse);

            const result1 = await claudeModel.getTextResponse('Request 1');
            const result2 = await claudeModel.getTextResponse('Request 2');
            const result3 = await claudeModel.getTextResponse('Request 3');

            expect(result1).toBe('Success');
            expect(result2).toBeNull();
            expect(result3).toBe('Success');
        });
    });
});
