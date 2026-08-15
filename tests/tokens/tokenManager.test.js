const TokenManager = require('../../src/tokens/tokenManager');
const { createMockDbManager } = require('../__mocks__/mockDbManager');

jest.mock('https');
jest.mock('node-fetch');
jest.mock('../../src/config/config', () => ({
    channelName: 'testchannel',
    twitchAuthEndpoint: 'https://id.twitch.tv/oauth2',
    tokenRefreshSafetyMargin: 900000,
    tokenRefreshInterval: 300000
}));

const https = require('https');
const fetch = require('node-fetch');
const { EventEmitter } = require('events');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

describe('TokenManager', () => {
    let tokenManager;
    let mockDbManager;

    /** Stubs the Twitch /oauth2/token POST with a given JSON body. */
    const stubRefreshResponse = (payload, { statusCode = 200 } = {}) => {
        https.request.mockImplementation((options, callback) => {
            const res = new EventEmitter();
            res.statusCode = statusCode;

            setTimeout(() => {
                callback(res);
                res.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
                res.emit('end');
            }, 0);

            return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
        });
    };

    const stubRefreshNetworkError = (error) => {
        https.request.mockImplementation(() => ({
            on: jest.fn((event, cb) => {
                if (event === 'error') {
                    setTimeout(() => cb(error), 0);
                }
            }),
            write: jest.fn(),
            end: jest.fn()
        }));
    };

    /** Stubs the Twitch /validate GET. */
    const stubValidate = ({ ok = true, userId = 'user-123', expiresIn = 14400 } = {}) => {
        fetch.mockResolvedValue({
            ok,
            status: ok ? 200 : 401,
            statusText: ok ? 'OK' : 'Unauthorized',
            json: jest.fn().mockResolvedValue(ok ? { user_id: userId, expires_in: expiresIn } : { message: 'invalid access token' })
        });
    };

    const seedTokens = (overrides = {}) => {
        tokenManager.tokens = {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            botAccessToken: 'old-bot-access',
            botRefreshToken: 'old-bot-refresh',
            broadcasterAccessToken: 'old-broadcaster-access',
            broadcasterRefreshToken: 'old-broadcaster-refresh',
            ...overrides
        };
    };

    /** Rows written inside the transaction, as [key, value] pairs. */
    const persistedRows = () =>
        mockDbManager._transaction.query.mock.calls.map(([, params]) => params);

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbManager = createMockDbManager();
        tokenManager = new TokenManager();
        tokenManager.dbManager = mockDbManager;
    });

    describe('constructor', () => {
        it('should initialize with empty tokens', () => {
            const fresh = new TokenManager();

            expect(fresh.dbManager).toBeNull();
            expect(fresh.tokens).toEqual({});
            expect(fresh.isInitialized).toBe(false);
        });
    });

    describe('loadTokensFromDatabase', () => {
        it('should load tokens from database successfully', async () => {
            mockDbManager.query.mockResolvedValue([
                { token_key: 'botAccessToken', token_value: 'bot-token-123' },
                { token_key: 'broadcasterAccessToken', token_value: 'broadcaster-token-456' },
                { token_key: 'clientId', token_value: 'client-789' }
            ]);

            await tokenManager.loadTokensFromDatabase();

            expect(mockDbManager.query).toHaveBeenCalledWith('SELECT token_key, token_value FROM tokens');
            expect(tokenManager.tokens).toEqual({
                botAccessToken: 'bot-token-123',
                broadcasterAccessToken: 'broadcaster-token-456',
                clientId: 'client-789'
            });
        });

        it('should load expiry rows alongside the tokens', async () => {
            mockDbManager.query.mockResolvedValue([
                { token_key: 'botAccessToken', token_value: 'bot-token' },
                { token_key: 'botAccessTokenExpiresAt', token_value: '1700000000000' }
            ]);

            await tokenManager.loadTokensFromDatabase();

            expect(tokenManager.tokens.botAccessTokenExpiresAt).toBe('1700000000000');
        });

        it('should throw a wrapped error on database failure', async () => {
            mockDbManager.query.mockRejectedValue(new Error('Connection lost'));

            await expect(tokenManager.loadTokensFromDatabase())
                .rejects.toThrow('Unable to load tokens from database');
        });

        it('should reset the tokens object before loading', async () => {
            tokenManager.tokens = { stale: 'value' };
            mockDbManager.query.mockResolvedValue([
                { token_key: 'botAccessToken', token_value: 'fresh' }
            ]);

            await tokenManager.loadTokensFromDatabase();

            expect(tokenManager.tokens.stale).toBeUndefined();
        });
    });

    describe('needsRefresh', () => {
        beforeEach(() => {
            seedTokens();
        });

        it('should refresh when no expiry has ever been recorded', () => {
            expect(tokenManager.needsRefresh('bot')).toBe(true);
        });

        it('should NOT refresh a token that is comfortably fresh', () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + FOUR_HOURS_MS);

            expect(tokenManager.needsRefresh('bot')).toBe(false);
        });

        it('should refresh a token inside the safety margin', () => {
            // 10 minutes left, margin is 15.
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + 10 * 60 * 1000);

            expect(tokenManager.needsRefresh('bot')).toBe(true);
        });

        it('should NOT refresh a token just outside the safety margin', () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + 16 * 60 * 1000);

            expect(tokenManager.needsRefresh('bot')).toBe(false);
        });

        it('should refresh an already-expired token', () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() - 1000);

            expect(tokenManager.needsRefresh('bot')).toBe(true);
        });

        it('should refresh when the stored expiry is unreadable', () => {
            tokenManager.tokens.botAccessTokenExpiresAt = 'not-a-number';

            expect(tokenManager.needsRefresh('bot')).toBe(true);
        });

        it('should track each token type independently', () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + FOUR_HOURS_MS);
            tokenManager.tokens.broadcasterAccessTokenExpiresAt = String(Date.now() + 60 * 1000);

            expect(tokenManager.needsRefresh('bot')).toBe(false);
            expect(tokenManager.needsRefresh('broadcaster')).toBe(true);
        });

        it('should reject an unknown token type', () => {
            expect(() => tokenManager.needsRefresh('nonsense')).toThrow('Unknown token type');
        });
    });

    describe('checkAndRefreshTokens', () => {
        beforeEach(() => {
            seedTokens();
            stubValidate();
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 14400
            });
        });

        it('should refresh nothing when both tokens are fresh', async () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + FOUR_HOURS_MS);
            tokenManager.tokens.broadcasterAccessTokenExpiresAt = String(Date.now() + FOUR_HOURS_MS);

            await tokenManager.checkAndRefreshTokens();

            // The check cadence stays at 5 minutes; the rotation rate does not.
            expect(https.request).not.toHaveBeenCalled();
            expect(mockDbManager.withTransaction).not.toHaveBeenCalled();
        });

        it('should refresh both tokens on a first run with no expiry recorded', async () => {
            await tokenManager.checkAndRefreshTokens();

            expect(https.request).toHaveBeenCalledTimes(2);
        });

        it('should refresh only the token that is near expiry', async () => {
            tokenManager.tokens.botAccessTokenExpiresAt = String(Date.now() + FOUR_HOURS_MS);
            tokenManager.tokens.broadcasterAccessTokenExpiresAt = String(Date.now() + 60 * 1000);

            await tokenManager.checkAndRefreshTokens();

            expect(https.request).toHaveBeenCalledTimes(1);
            expect(tokenManager.tokens.broadcasterAccessToken).toBe('new-access');
            expect(tokenManager.tokens.botAccessToken).toBe('old-bot-access');
        });

        it('should not refresh again on the next check after a successful refresh', async () => {
            await tokenManager.checkAndRefreshTokens();
            jest.clearAllMocks();

            await tokenManager.checkAndRefreshTokens();

            expect(https.request).not.toHaveBeenCalled();
        });

        it('should not throw when one token fails to refresh', async () => {
            stubRefreshNetworkError(new Error('Twitch unreachable'));

            const outcomes = await tokenManager.checkAndRefreshTokens();

            expect(outcomes.every(o => o.failed)).toBe(true);
        });

        it('should still refresh the healthy token when the other fails', async () => {
            let call = 0;
            https.request.mockImplementation((options, callback) => {
                call += 1;
                if (call === 1) {
                    return {
                        on: jest.fn((event, cb) => {
                            if (event === 'error') setTimeout(() => cb(new Error('boom')), 0);
                        }),
                        write: jest.fn(),
                        end: jest.fn()
                    };
                }

                const res = new EventEmitter();
                res.statusCode = 200;
                setTimeout(() => {
                    callback(res);
                    res.emit('data', JSON.stringify({
                        access_token: 'new-access',
                        refresh_token: 'new-refresh',
                        expires_in: 14400
                    }));
                    res.emit('end');
                }, 0);
                return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
            });

            await tokenManager.checkAndRefreshTokens();

            expect(mockDbManager.withTransaction).toHaveBeenCalledTimes(1);
        });
    });

    describe('refreshToken - atomic persistence', () => {
        beforeEach(() => {
            seedTokens();
            stubValidate({ userId: 'bot-user-99' });
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 14400
            });
        });

        it('should persist access, refresh, expiry and id in ONE transaction', async () => {
            await tokenManager.refreshToken('bot');

            expect(mockDbManager.withTransaction).toHaveBeenCalledTimes(1);

            const keys = persistedRows().map(([key]) => key);
            expect(keys).toEqual([
                'botAccessToken',
                'botRefreshToken',
                'botAccessTokenExpiresAt',
                'botId'
            ]);
        });

        it('should never write tokens outside the transaction', async () => {
            await tokenManager.refreshToken('bot');

            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should upsert rather than update, so new expiry rows can be created', async () => {
            await tokenManager.refreshToken('bot');

            const [sql] = mockDbManager._transaction.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO tokens');
            expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        });

        it('should record an expiry derived from expires_in', async () => {
            const before = Date.now();

            await tokenManager.refreshToken('bot');

            const expiresAt = Number(tokenManager.tokens.botAccessTokenExpiresAt);
            expect(expiresAt).toBeGreaterThanOrEqual(before + 14400 * 1000);
            expect(expiresAt).toBeLessThanOrEqual(Date.now() + 14400 * 1000);
        });

        it('should commit before updating memory', async () => {
            await tokenManager.refreshToken('bot');

            expect(mockDbManager._transaction.commit).toHaveBeenCalled();
            expect(tokenManager.tokens.botAccessToken).toBe('new-access');
            expect(tokenManager.tokens.botRefreshToken).toBe('new-refresh');
        });

        it('should leave memory untouched when the transaction fails', async () => {
            mockDbManager._transaction.query.mockRejectedValue(new Error('Deadlock'));

            await expect(tokenManager.refreshToken('bot')).rejects.toThrow('Deadlock');

            // The rotated pair must not half-land: a crash here previously stranded
            // the bot with a persisted access token and a lost refresh token.
            expect(tokenManager.tokens.botAccessToken).toBe('old-bot-access');
            expect(tokenManager.tokens.botRefreshToken).toBe('old-bot-refresh');
            expect(tokenManager.tokens.botAccessTokenExpiresAt).toBeUndefined();
            expect(mockDbManager._transaction.rollback).toHaveBeenCalled();
        });

        it('should return the new access token', async () => {
            await expect(tokenManager.refreshToken('bot')).resolves.toBe('new-access');
        });
    });

    describe('refreshToken - per-type identity (P1-11)', () => {
        beforeEach(() => {
            seedTokens();
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 14400
            });
        });

        it('should validate the BOT token and persist botId', async () => {
            stubValidate({ userId: 'bot-user-99' });

            await tokenManager.refreshToken('bot');

            expect(fetch).toHaveBeenCalledWith(
                'https://id.twitch.tv/oauth2/validate',
                { headers: { Authorization: 'Bearer new-access' } }
            );
            expect(tokenManager.tokens.botId).toBe('bot-user-99');
            expect(tokenManager.tokens.userId).toBeUndefined();
        });

        it('should validate the BROADCASTER token and persist userId', async () => {
            stubValidate({ userId: 'broadcaster-user-42' });

            await tokenManager.refreshToken('broadcaster');

            // The old code revalidated the bot token here and only ever wrote botId.
            expect(tokenManager.tokens.userId).toBe('broadcaster-user-42');
            expect(tokenManager.tokens.botId).toBeUndefined();
        });

        it('should write the broadcaster id inside the same transaction', async () => {
            stubValidate({ userId: 'broadcaster-user-42' });

            await tokenManager.refreshToken('broadcaster');

            const keys = persistedRows().map(([key]) => key);
            expect(keys).toContain('userId');
            expect(keys).not.toContain('botId');
        });

        it('should still rotate the pair when validation is unavailable', async () => {
            fetch.mockRejectedValue(new Error('validate endpoint down'));

            await tokenManager.refreshToken('bot');

            expect(tokenManager.tokens.botAccessToken).toBe('new-access');
            const keys = persistedRows().map(([key]) => key);
            expect(keys).not.toContain('botId');
        });
    });

    describe('refreshToken - failures', () => {
        beforeEach(() => {
            seedTokens();
            stubValidate();
        });

        it('should reject with a real Error on an invalid response', async () => {
            stubRefreshResponse({ message: 'Something went wrong' });

            const failure = await tokenManager.refreshToken('bot').catch(e => e);

            expect(failure).toBeInstanceOf(Error);
            expect(failure.message).toContain('Failed to refresh bot tokens');
            expect(failure.stack).toBeDefined();
        });

        it('should reject with a real Error on a parse failure', async () => {
            stubRefreshResponse('not json at all');

            const failure = await tokenManager.refreshToken('bot').catch(e => e);

            expect(failure).toBeInstanceOf(Error);
            expect(failure.message).toContain('Failed to parse Twitch API response');
        });

        it('should reject with a real Error on a network failure', async () => {
            stubRefreshNetworkError(new Error('ECONNRESET'));

            const failure = await tokenManager.refreshToken('bot').catch(e => e);

            expect(failure).toBeInstanceOf(Error);
            expect(failure.message).toContain('Network error during bot token refresh');
        });

        it('should not persist anything when the refresh request fails', async () => {
            stubRefreshResponse({ message: 'nope' });

            await expect(tokenManager.refreshToken('bot')).rejects.toThrow();

            expect(mockDbManager.withTransaction).not.toHaveBeenCalled();
        });

        it('should flag a dead refresh token as needing manual re-authorization', async () => {
            const logger = require('../../src/logger/logger');
            stubRefreshResponse({ status: 400, message: 'Invalid refresh token' });

            await expect(tokenManager.refreshToken('bot')).rejects.toThrow();

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                expect.stringContaining('MANUAL RE-AUTHORIZATION REQUIRED'),
                expect.any(Object)
            );
        });

        it('should detect a dead refresh token from the message alone', () => {
            expect(tokenManager.isDeadRefreshToken({ message: 'Invalid refresh token' })).toBe(true);
            expect(tokenManager.isDeadRefreshToken({ status: 400 })).toBe(true);
            expect(tokenManager.isDeadRefreshToken({ message: 'server error' })).toBe(false);
        });
    });

    describe('validateToken', () => {
        beforeEach(() => {
            seedTokens();
        });

        it('should persist botId when validating the bot token', async () => {
            stubValidate({ userId: 'bot-9' });

            await expect(tokenManager.validateToken('bot')).resolves.toBe(true);

            expect(tokenManager.tokens.botId).toBe('bot-9');
        });

        it('should persist userId when validating the broadcaster token', async () => {
            stubValidate({ userId: 'broadcaster-9' });

            await expect(tokenManager.validateToken('broadcaster')).resolves.toBe(true);

            expect(tokenManager.tokens.userId).toBe('broadcaster-9');
        });

        it('should validate using that type own access token', async () => {
            stubValidate();

            await tokenManager.validateToken('broadcaster');

            expect(fetch).toHaveBeenCalledWith(
                'https://id.twitch.tv/oauth2/validate',
                { headers: { Authorization: 'Bearer old-broadcaster-access' } }
            );
        });

        it('should record expiry from the validate response', async () => {
            stubValidate({ expiresIn: 3600 });

            await tokenManager.validateToken('bot');

            expect(Number(tokenManager.tokens.botAccessTokenExpiresAt))
                .toBeGreaterThan(Date.now());
        });

        it('should refresh when Twitch rejects the token', async () => {
            stubValidate({ ok: false });
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 14400
            });

            await expect(tokenManager.validateToken('bot')).resolves.toBe(true);

            expect(https.request).toHaveBeenCalled();
        });

        it('should return false on an unexpected error', async () => {
            fetch.mockRejectedValue(new Error('Network down'));

            await expect(tokenManager.validateToken('bot')).resolves.toBe(false);
        });
    });

    describe('updateToken', () => {
        it('should upsert and update memory', async () => {
            seedTokens();

            await tokenManager.updateToken('botId', 'abc');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('ON DUPLICATE KEY UPDATE'),
                ['botId', 'abc']
            );
            expect(tokenManager.tokens.botId).toBe('abc');
        });

        it('should propagate a database error', async () => {
            mockDbManager.query.mockRejectedValue(new Error('DB down'));

            await expect(tokenManager.updateToken('botId', 'abc')).rejects.toThrow('DB down');
        });
    });

    describe('saveTokens', () => {
        it('should upsert every token', async () => {
            tokenManager.tokens = { botAccessToken: 'a', clientId: 'b' };

            await tokenManager.saveTokens();

            expect(mockDbManager.query).toHaveBeenCalledTimes(2);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tokens'),
                ['botAccessToken', 'a']
            );
        });

        it('should propagate a database error', async () => {
            tokenManager.tokens = { botAccessToken: 'a' };
            mockDbManager.query.mockRejectedValue(new Error('DB down'));

            await expect(tokenManager.saveTokens()).rejects.toThrow('DB down');
        });
    });

    describe('getChannelName', () => {
        it('should return the channel name from config', () => {
            expect(tokenManager.getChannelName()).toBe('testchannel');
        });
    });

    describe('getBroadcasterToken', () => {
        it('should return the broadcaster access token', () => {
            seedTokens();

            expect(tokenManager.getBroadcasterToken()).toBe('old-broadcaster-access');
        });
    });

    describe('init', () => {
        it('should load tokens then evaluate expiry', async () => {
            mockDbManager.query.mockResolvedValue([
                { token_key: 'clientId', token_value: 'client-id' },
                { token_key: 'clientSecret', token_value: 'client-secret' },
                { token_key: 'botRefreshToken', token_value: 'bot-refresh' },
                { token_key: 'broadcasterRefreshToken', token_value: 'broadcaster-refresh' },
                { token_key: 'botAccessTokenExpiresAt', token_value: String(Date.now() + FOUR_HOURS_MS) },
                { token_key: 'broadcasterAccessTokenExpiresAt', token_value: String(Date.now() + FOUR_HOURS_MS) }
            ]);

            await tokenManager.init(mockDbManager);

            expect(tokenManager.isInitialized).toBe(true);
            // Both tokens were fresh, so boot cost zero refreshes.
            expect(https.request).not.toHaveBeenCalled();
        });

        it('should refresh on first boot when no expiry rows exist yet', async () => {
            mockDbManager.query.mockResolvedValue([
                { token_key: 'clientId', token_value: 'client-id' },
                { token_key: 'clientSecret', token_value: 'client-secret' },
                { token_key: 'botRefreshToken', token_value: 'bot-refresh' },
                { token_key: 'broadcasterRefreshToken', token_value: 'broadcaster-refresh' }
            ]);
            stubValidate();
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 14400
            });

            await tokenManager.init(mockDbManager);

            // Migration behaviour: unknown expiry means refresh once, then settle.
            expect(https.request).toHaveBeenCalledTimes(2);
            expect(tokenManager.tokens.botAccessTokenExpiresAt).toBeDefined();
            expect(tokenManager.tokens.broadcasterAccessTokenExpiresAt).toBeDefined();
        });
    });


    describe('expires_in sanity floor', () => {
        beforeEach(() => {
            seedTokens();
            stubValidate({ expiresIn: 60 });
            stubRefreshResponse({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 60
            });
        });

        it('should floor an implausibly short lifetime', () => {
            const expiresAt = tokenManager.computeExpiresAt(60);

            // 60s would sit permanently inside the 15-minute margin, restoring the
            // every-check rotation this design removes.
            expect(expiresAt - Date.now()).toBeGreaterThanOrEqual(900000 + 300000 - 50);
        });

        it('should trust a normal lifetime', () => {
            const expiresAt = tokenManager.computeExpiresAt(14400);

            expect(expiresAt - Date.now()).toBeGreaterThan(14000 * 1000);
        });

        it('should floor a zero or missing lifetime', () => {
            expect(tokenManager.computeExpiresAt(0) - Date.now())
                .toBeGreaterThanOrEqual(900000 + 300000 - 50);
            expect(tokenManager.computeExpiresAt(undefined) - Date.now())
                .toBeGreaterThanOrEqual(900000 + 300000 - 50);
        });

        it('should not re-refresh immediately after a floored refresh', async () => {
            await tokenManager.refreshToken('bot');

            expect(tokenManager.needsRefresh('bot')).toBe(false);
        });
    });

    describe('boot health check', () => {
        beforeEach(() => {
            seedTokens();
        });

        it('should validate tokens that were not refreshed', async () => {
            stubValidate({ userId: 'u-1' });

            await tokenManager.verifyTokenHealth([
                { type: 'bot', refreshed: false },
                { type: 'broadcaster', refreshed: false }
            ]);

            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it('should skip a token that was just refreshed', async () => {
            stubValidate({ userId: 'u-1' });

            await tokenManager.verifyTokenHealth([
                { type: 'bot', refreshed: true },
                { type: 'broadcaster', refreshed: false }
            ]);

            // A refresh already validated that token; re-checking is a wasted call.
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        it('should surface a revoked token at boot rather than mid-stream', async () => {
            const logger = require('../../src/logger/logger');
            stubValidate({ ok: false });
            stubRefreshNetworkError(new Error('refresh also fails'));

            await tokenManager.verifyTokenHealth([{ type: 'bot', refreshed: false }]);

            expect(logger.error).toHaveBeenCalledWith(
                'TokenManager',
                'Token failed its boot health check',
                { type: 'bot' }
            );
        });
    });
});
