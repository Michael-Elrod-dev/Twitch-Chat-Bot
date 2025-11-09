// tests/tokens/tokenManager.test.js

const TokenManager = require('../../src/tokens/tokenManager');

// Mock https
jest.mock('https');
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
    channelName: 'testchannel',
    twitchAuthEndpoint: 'https://id.twitch.tv/oauth2'
}));

const https = require('https');
const fetch = require('node-fetch');
const logger = require('../../src/logger/logger');
const { EventEmitter } = require('events');

describe('TokenManager', () => {
    let tokenManager;
    let mockDbManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = {
            query: jest.fn()
        };

        tokenManager = new TokenManager();
    });

    describe('constructor', () => {
        it('should initialize with empty tokens', () => {
            expect(tokenManager.dbManager).toBeNull();
            expect(tokenManager.tokens).toEqual({});
            expect(tokenManager.isInitialized).toBe(false);
            expect(logger.debug).toHaveBeenCalledWith('TokenManager', 'TokenManager instance created');
        });
    });

    describe('loadTokensFromDatabase', () => {
        it('should load tokens from database successfully', async () => {
            const mockTokenRows = [
                { token_key: 'botAccessToken', token_value: 'bot-token-123' },
                { token_key: 'broadcasterAccessToken', token_value: 'broadcaster-token-456' },
                { token_key: 'clientId', token_value: 'client-789' }
            ];
            mockDbManager.query.mockResolvedValue(mockTokenRows);

            tokenManager.dbManager = mockDbManager;
            await tokenManager.loadTokensFromDatabase();

            expect(mockDbManager.query).toHaveBeenCalledWith('SELECT token_key, token_value FROM tokens');
            expect(tokenManager.tokens).toEqual({
                botAccessToken: 'bot-token-123',
                broadcasterAccessToken: 'broadcaster-token-456',
                clientId: 'client-789'
            });
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Loaded tokens from database',
                expect.objectContaining({
                    tokenCount: 3,
                    tokenKeys: ['botAccessToken', 'broadcasterAccessToken', 'clientId']
                })
            );
        });

        it('should handle database error', async () => {
            const dbError = new Error('Database connection failed');
            dbError.stack = 'Error stack';
            mockDbManager.query.mockRejectedValue(dbError);

            tokenManager.dbManager = mockDbManager;

            await expect(tokenManager.loadTokensFromDatabase()).rejects.toThrow('Unable to load tokens from database');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Error loading tokens from database',
                expect.objectContaining({
                    error: 'Database connection failed'
                })
            );
        });

        it('should reset tokens object before loading', async () => {
            tokenManager.tokens = { old: 'data' };
            mockDbManager.query.mockResolvedValue([{ token_key: 'new', token_value: 'value' }]);

            tokenManager.dbManager = mockDbManager;
            await tokenManager.loadTokensFromDatabase();

            expect(tokenManager.tokens).toEqual({ new: 'value' });
        });
    });

    describe('saveTokens', () => {
        it('should save all tokens to database', async () => {
            tokenManager.dbManager = mockDbManager;
            tokenManager.tokens = {
                botAccessToken: 'bot-123',
                broadcasterAccessToken: 'broadcaster-456',
                clientId: 'client-789'
            };

            await tokenManager.saveTokens();

            expect(mockDbManager.query).toHaveBeenCalledTimes(3);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE tokens'),
                ['bot-123', 'botAccessToken']
            );
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE tokens'),
                ['broadcaster-456', 'broadcasterAccessToken']
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Successfully saved all tokens to database',
                expect.objectContaining({ tokenCount: 3 })
            );
        });

        it('should handle database error', async () => {
            const dbError = new Error('Update failed');
            dbError.stack = 'Error stack';
            tokenManager.dbManager = mockDbManager;
            tokenManager.tokens = { test: 'token' };
            mockDbManager.query.mockRejectedValue(dbError);

            await expect(tokenManager.saveTokens()).rejects.toThrow('Update failed');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Error saving tokens to database',
                expect.objectContaining({
                    error: 'Update failed'
                })
            );
        });
    });

    describe('updateToken', () => {
        it('should update token in memory and database', async () => {
            tokenManager.dbManager = mockDbManager;

            await tokenManager.updateToken('botAccessToken', 'new-bot-token');

            expect(tokenManager.tokens.botAccessToken).toBe('new-bot-token');
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE tokens'),
                ['new-bot-token', 'botAccessToken']
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'TokenManager',
                'Successfully updated token',
                { tokenKey: 'botAccessToken' }
            );
        });

        it('should handle database error', async () => {
            const dbError = new Error('Update failed');
            dbError.stack = 'Error stack';
            tokenManager.dbManager = mockDbManager;
            mockDbManager.query.mockRejectedValue(dbError);

            await expect(tokenManager.updateToken('test', 'value')).rejects.toThrow('Update failed');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Error updating token',
                expect.objectContaining({
                    error: 'Update failed',
                    tokenKey: 'test'
                })
            );
        });
    });

    describe('getChannelName', () => {
        it('should return channel name from config', () => {
            expect(tokenManager.getChannelName()).toBe('testchannel');
        });
    });

    describe('validateToken', () => {
        it('should validate bot token successfully', async () => {
            tokenManager.tokens = {
                botAccessToken: 'bot-token',
                broadcasterAccessToken: 'broadcaster-token'
            };
            tokenManager.dbManager = mockDbManager;

            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    user_id: 'bot-user-123',
                    expires_in: 3600
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await tokenManager.validateToken('bot');

            expect(result).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                'https://id.twitch.tv/oauth2/validate',
                expect.objectContaining({
                    headers: { 'Authorization': 'Bearer bot-token' }
                })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Token validated successfully',
                expect.objectContaining({
                    type: 'bot',
                    userId: 'bot-user-123',
                    expiresIn: 3600
                })
            );
        });

        it('should validate broadcaster token successfully', async () => {
            tokenManager.tokens = {
                botAccessToken: 'bot-token',
                broadcasterAccessToken: 'broadcaster-token'
            };
            tokenManager.dbManager = mockDbManager;

            const mockResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    user_id: 'broadcaster-user-456',
                    expires_in: 7200
                })
            };
            fetch.mockResolvedValue(mockResponse);

            const result = await tokenManager.validateToken('broadcaster');

            expect(result).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                'https://id.twitch.tv/oauth2/validate',
                expect.objectContaining({
                    headers: { 'Authorization': 'Bearer broadcaster-token' }
                })
            );
        });

        it('should refresh token when validation fails', async () => {
            tokenManager.tokens = {
                botAccessToken: 'old-bot-token',
                botRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };
            tokenManager.dbManager = mockDbManager;

            // First validation fails
            const failedResponse = {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                json: jest.fn().mockResolvedValue({ error: 'invalid_token' })
            };

            // After refresh, validation succeeds (2 calls: one in refresh, one after)
            const successResponse = {
                ok: true,
                json: jest.fn().mockResolvedValue({
                    user_id: 'bot-user-123',
                    expires_in: 3600
                })
            };

            fetch
                .mockResolvedValueOnce(failedResponse)  // Initial validation fails
                .mockResolvedValueOnce(successResponse) // Validation inside refreshToken
                .mockResolvedValueOnce(successResponse); // Validation after refresh

            // Mock refresh
            const mockRefreshResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setImmediate(() => {
                    callback(mockRefreshResponse);
                    setImmediate(() => {
                        mockRefreshResponse.emit('data', JSON.stringify({
                            access_token: 'new-bot-token',
                            refresh_token: 'new-refresh-token'
                        }));
                        mockRefreshResponse.emit('end');
                    });
                });
                mockRefreshResponse.statusCode = 200;
                return mockRequest;
            });

            const result = await tokenManager.validateToken('bot');

            expect(result).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                'TokenManager',
                'Token validation failed, refreshing token',
                expect.objectContaining({ type: 'bot' })
            );
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Token refreshed and validated successfully',
                expect.objectContaining({
                    type: 'bot',
                    userId: 'bot-user-123'
                })
            );
        });

        it('should return false on validation error', async () => {
            tokenManager.tokens = { botAccessToken: 'token' };
            const networkError = new Error('Network error');
            networkError.stack = 'Error stack';
            fetch.mockRejectedValue(networkError);

            const result = await tokenManager.validateToken('bot');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Token validation failed',
                expect.objectContaining({
                    error: 'Network error',
                    type: 'bot'
                })
            );
        });
    });

    describe('refreshToken', () => {
        it('should refresh bot token successfully', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };
            tokenManager.dbManager = mockDbManager;

            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token'
                    }));
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 200;
                return mockRequest;
            });

            // Mock validation call
            fetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ user_id: 'bot-123' })
            });

            const result = await tokenManager.refreshToken('bot');

            expect(result).toBe('new-access-token');
            expect(mockRequest.write).toHaveBeenCalled();
            expect(mockRequest.end).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Bot token refreshed successfully',
                expect.objectContaining({ userId: 'bot-123' })
            );
        });

        it('should refresh broadcaster token successfully', async () => {
            tokenManager.tokens = {
                broadcasterRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };
            tokenManager.dbManager = mockDbManager;

            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        access_token: 'new-broadcaster-token',
                        refresh_token: 'new-refresh-token'
                    }));
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 200;
                return mockRequest;
            });

            const result = await tokenManager.refreshToken('broadcaster');

            expect(result).toBe('new-broadcaster-token');
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'Broadcaster token refreshed successfully'
            );
        });

        it('should handle invalid response', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };

            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        error: 'invalid_grant',
                        message: 'Invalid refresh token'
                    }));
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 400;
                return mockRequest;
            });

            await expect(tokenManager.refreshToken('bot')).rejects.toMatch('Failed to refresh bot tokens');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Token refresh failed - invalid response',
                expect.objectContaining({
                    type: 'bot',
                    error: 'Invalid refresh token'
                })
            );
        });

        it('should handle JSON parse error', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };

            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', 'invalid json');
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 200;
                return mockRequest;
            });

            await expect(tokenManager.refreshToken('bot')).rejects.toMatch('Failed to parse Twitch API response');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Token refresh failed - parse error',
                expect.objectContaining({
                    type: 'bot',
                    responseData: 'invalid json'
                })
            );
        });

        it('should handle network error', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };

            const mockRequest = {
                on: jest.fn((event, callback) => {
                    if (event === 'error') {
                        setTimeout(() => callback(new Error('Network failure')), 0);
                    }
                }),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockReturnValue(mockRequest);

            await expect(tokenManager.refreshToken('bot')).rejects.toMatch('Network error during bot token refresh');

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Token refresh failed - network error',
                expect.objectContaining({
                    error: 'Network failure',
                    type: 'bot'
                })
            );
        });
    });

    describe('checkAndRefreshTokens', () => {
        it('should refresh and validate both tokens successfully', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'bot-refresh',
                broadcasterRefreshToken: 'broadcaster-refresh',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };
            tokenManager.dbManager = mockDbManager;

            // Mock refresh
            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        access_token: 'new-token',
                        refresh_token: 'new-refresh'
                    }));
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 200;
                return mockRequest;
            });

            // Mock validation
            fetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ user_id: 'user-123', expires_in: 3600 })
            });

            await tokenManager.checkAndRefreshTokens();

            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'All tokens refreshed and validated successfully'
            );
        });

        it('should handle bot token refresh failure', async () => {
            tokenManager.tokens = {
                botRefreshToken: 'bot-refresh',
                broadcasterRefreshToken: 'broadcaster-refresh',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            };

            const mockRequest = {
                on: jest.fn((event, callback) => {
                    if (event === 'error') {
                        setTimeout(() => callback(new Error('Bot refresh failed')), 0);
                    }
                }),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockReturnValue(mockRequest);

            await tokenManager.checkAndRefreshTokens();

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Critical error refreshing tokens',
                expect.objectContaining({
                    error: 'Bot token refresh failed'
                })
            );
            expect(logger.warn).toHaveBeenCalledWith(
                'TokenManager',
                'You may need to re-authenticate with Twitch'
            );
        });
    });

    describe('init', () => {
        it('should initialize successfully', async () => {
            mockDbManager.query.mockResolvedValue([
                { token_key: 'botAccessToken', token_value: 'bot-token' },
                { token_key: 'botRefreshToken', token_value: 'bot-refresh' },
                { token_key: 'broadcasterRefreshToken', token_value: 'broadcaster-refresh' },
                { token_key: 'clientId', token_value: 'client-id' },
                { token_key: 'clientSecret', token_value: 'client-secret' }
            ]);

            const mockResponse = new EventEmitter();
            const mockRequest = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn()
            };

            https.request.mockImplementation((options, callback) => {
                setTimeout(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        access_token: 'new-token',
                        refresh_token: 'new-refresh'
                    }));
                    mockResponse.emit('end');
                }, 0);
                mockResponse.statusCode = 200;
                return mockRequest;
            });

            fetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ user_id: 'user-123', expires_in: 3600 })
            });

            await tokenManager.init(mockDbManager);

            expect(tokenManager.dbManager).toBe(mockDbManager);
            expect(tokenManager.isInitialized).toBe(true);
            expect(logger.info).toHaveBeenCalledWith(
                'TokenManager',
                'TokenManager initialized successfully'
            );
        });
    });

    describe('getConfig', () => {
        it('should return bot configuration', () => {
            tokenManager.tokens = {
                botAccessToken: 'bot-token-abc',
                clientId: 'client-123'
            };

            const config = tokenManager.getConfig();

            expect(config).toEqual({
                identity: {
                    username: 'almosthadai',
                    password: 'oauth:bot-token-abc'
                },
                channels: ['aimosthadme'],
                options: {
                    clientId: 'client-123'
                }
            });
        });
    });

    describe('getBroadcasterToken', () => {
        it('should return broadcaster access token', () => {
            tokenManager.tokens = {
                broadcasterAccessToken: 'broadcaster-token-xyz'
            };

            const token = tokenManager.getBroadcasterToken();

            expect(token).toBe('broadcaster-token-xyz');
            expect(logger.debug).toHaveBeenCalledWith(
                'TokenManager',
                'Retrieving broadcaster token'
            );
        });
    });
});
