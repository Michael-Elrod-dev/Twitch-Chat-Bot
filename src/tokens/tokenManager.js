const https = require('https');
const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

// Every key/value row a token type owns. Expiry lives in the existing tokens
// table as its own row - no schema change needed.
const TOKEN_KEYS = {
    bot: {
        access: 'botAccessToken',
        refresh: 'botRefreshToken',
        expiresAt: 'botAccessTokenExpiresAt',
        id: 'botId'
    },
    broadcaster: {
        access: 'broadcasterAccessToken',
        refresh: 'broadcasterRefreshToken',
        expiresAt: 'broadcasterAccessTokenExpiresAt',
        id: 'userId'
    }
};

const TOKEN_TYPES = Object.keys(TOKEN_KEYS);

// A token whose reported lifetime is shorter than this would sit permanently
// inside the refresh margin, putting us straight back to rotating on every check.
const MIN_TOKEN_LIFETIME_MS = config.tokenRefreshSafetyMargin + config.tokenRefreshInterval;

const UPSERT_TOKEN_SQL = `
    INSERT INTO tokens (token_key, token_value)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE token_value = VALUES(token_value), updated_at = CURRENT_TIMESTAMP
`;

class TokenManager {
    constructor() {
        this.dbManager = null;
        this.tokens = {};
        this.isInitialized = false;
        logger.debug('TokenManager', 'TokenManager instance created');
    }

    async init(dbManager) {
        logger.debug('TokenManager', 'Initializing TokenManager');
        this.dbManager = dbManager;
        await this.loadTokensFromDatabase();

        const outcomes = await this.checkAndRefreshTokens();
        await this.verifyTokenHealth(outcomes);

        this.isInitialized = true;
        logger.info('TokenManager', 'TokenManager initialized successfully');
    }

    /**
     * Boot health check. Expiry-based refresh means a healthy-looking boot can now
     * contact Twitch zero times - so a token revoked out of band (the broadcaster
     * disconnecting the app) would still look fine until the first chat send failed
     * mid-stream. Validating the tokens we did NOT just refresh turns that into a
     * loud startup failure instead, at a cost of at most two calls per process start.
     */
    async verifyTokenHealth(outcomes = []) {
        const refreshed = new Set(outcomes.filter(o => o.refreshed).map(o => o.type));

        for (const type of TOKEN_TYPES) {
            if (refreshed.has(type)) {
                continue;
            }

            const healthy = await this.validateToken(type);
            if (!healthy) {
                logger.error('TokenManager', 'Token failed its boot health check', { type });
            }
        }
    }

    getTokenKeys(type) {
        const keys = TOKEN_KEYS[type];
        if (!keys) {
            throw new Error(`Unknown token type: ${type}`);
        }
        return keys;
    }

    async loadTokensFromDatabase() {
        try {
            logger.debug('TokenManager', 'Loading tokens from database');

            const rows = await this.dbManager.query('SELECT token_key, token_value FROM tokens');
            this.tokens = {};

            for (const row of rows) {
                this.tokens[row.token_key] = row.token_value;
            }

            logger.info('TokenManager', 'Loaded tokens from database', {
                tokenCount: rows.length,
                tokenKeys: Object.keys(this.tokens)
            });
        } catch (error) {
            logger.error('TokenManager', 'Error loading tokens from database', {
                error: error.message,
                stack: error.stack
            });
            throw new Error('Unable to load tokens from database', { cause: error });
        }
    }

    async saveTokens() {
        try {
            logger.debug('TokenManager', 'Saving all tokens to database', {
                tokenCount: Object.keys(this.tokens).length
            });

            for (const [key, value] of Object.entries(this.tokens)) {
                await this.dbManager.query(UPSERT_TOKEN_SQL, [key, value]);
            }

            logger.info('TokenManager', 'Successfully saved all tokens to database', {
                tokenCount: Object.keys(this.tokens).length
            });
        } catch (error) {
            logger.error('TokenManager', 'Error saving tokens to database', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async updateToken(tokenKey, tokenValue) {
        try {
            logger.debug('TokenManager', 'Updating token', { tokenKey });

            await this.dbManager.query(UPSERT_TOKEN_SQL, [tokenKey, tokenValue]);
            this.tokens[tokenKey] = tokenValue;

            logger.debug('TokenManager', 'Successfully updated token', { tokenKey });
        } catch (error) {
            logger.error('TokenManager', 'Error updating token', {
                error: error.message,
                stack: error.stack,
                tokenKey
            });
            throw error;
        }
    }

    getChannelName() {
        return config.channelName;
    }

    /**
     * A token needs refreshing when it is inside the safety margin of its expiry,
     * or when we have no expiry recorded at all (first run after this feature
     * shipped, or a row that was never written).
     */
    needsRefresh(type) {
        const keys = this.getTokenKeys(type);
        const recorded = this.tokens[keys.expiresAt];

        if (!recorded) {
            logger.info('TokenManager', 'No expiry recorded, refreshing', { type });
            return true;
        }

        const expiresAt = Number(recorded);
        if (!Number.isFinite(expiresAt)) {
            logger.warn('TokenManager', 'Unreadable expiry, refreshing', { type, recorded });
            return true;
        }

        const msUntilExpiry = expiresAt - Date.now();
        const due = msUntilExpiry <= config.tokenRefreshSafetyMargin;

        logger.debug('TokenManager', 'Evaluated token expiry', {
            type,
            minutesUntilExpiry: Math.round(msUntilExpiry / 60000),
            due
        });

        return due;
    }

    /**
     * Runs on the periodic check cadence. Only tokens actually near expiry are
     * refreshed, so a 5-minute check interval no longer means a 5-minute rotation.
     */
    async checkAndRefreshTokens() {
        logger.debug('TokenManager', 'Checking token expiry');

        const outcomes = await Promise.all(
            TOKEN_TYPES.map(async (type) => {
                if (!this.needsRefresh(type)) {
                    return { type, refreshed: false };
                }

                try {
                    await this.refreshToken(type);
                    return { type, refreshed: true };
                } catch (error) {
                    logger.error('TokenManager', 'Failed to refresh token', {
                        type,
                        error: error.message,
                        stack: error.stack
                    });
                    return { type, refreshed: false, failed: true };
                }
            })
        );

        const refreshed = outcomes.filter(o => o.refreshed).map(o => o.type);
        const failed = outcomes.filter(o => o.failed).map(o => o.type);

        if (failed.length > 0) {
            logger.warn('TokenManager', 'Some tokens could not be refreshed', { failed });
        }

        logger.info('TokenManager', 'Token check complete', {
            refreshed,
            skipped: outcomes.filter(o => !o.refreshed && !o.failed).map(o => o.type)
        });

        return outcomes;
    }

    /**
     * Validates the token belonging to `type` - not always the bot token, which is
     * what the old cross-wired version did - and persists that type's own id.
     */
    async validateToken(type = 'bot') {
        try {
            logger.debug('TokenManager', 'Validating token', { type });

            const keys = this.getTokenKeys(type);
            const identity = await this.fetchIdentity(this.tokens[keys.access]);

            if (!identity) {
                logger.warn('TokenManager', 'Token validation failed, refreshing token', { type });
                await this.refreshToken(type);
                return true;
            }

            await this.updateToken(keys.id, identity.userId);

            if (identity.expiresIn) {
                await this.updateToken(keys.expiresAt, String(this.computeExpiresAt(identity.expiresIn)));
            }

            logger.info('TokenManager', 'Token validated successfully', {
                type,
                userId: identity.userId,
                expiresIn: identity.expiresIn
            });

            return true;
        } catch (error) {
            logger.error('TokenManager', 'Token validation failed', {
                error: error.message,
                stack: error.stack,
                type
            });
            return false;
        }
    }

    /** Returns {userId, expiresIn} for a token, or null when Twitch rejects it. */
    async fetchIdentity(accessToken) {
        const response = await fetch(`${config.twitchAuthEndpoint}/validate`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const data = await response.json();

        if (!response.ok) {
            logger.warn('TokenManager', 'Token rejected by Twitch validate endpoint', {
                status: response.status,
                statusText: response.statusText
            });
            return null;
        }

        return { userId: data.user_id, expiresIn: data.expires_in };
    }

    /**
     * Rotates a token pair. Twitch issues a NEW refresh token on every refresh, so
     * access token, refresh token, expiry and id are persisted in a single
     * transaction - a crash between two separate writes used to be able to strand
     * the bot with a dead refresh token. In-memory state moves only after commit.
     */
    async refreshToken(type = 'bot') {
        logger.debug('TokenManager', 'Refreshing token', { type });

        const keys = this.getTokenKeys(type);
        const result = await this.requestNewTokens(type, this.tokens[keys.refresh]);

        let identity = null;
        try {
            identity = await this.fetchIdentity(result.access_token);
        } catch (error) {
            logger.warn('TokenManager', 'Could not validate freshly refreshed token', {
                type,
                error: error.message
            });
        }

        const expiresInSeconds = identity?.expiresIn || result.expires_in;
        const expiresAt = this.computeExpiresAt(expiresInSeconds);

        const rows = [
            [keys.access, result.access_token],
            [keys.refresh, result.refresh_token],
            [keys.expiresAt, String(expiresAt)]
        ];

        if (identity?.userId) {
            rows.push([keys.id, String(identity.userId)]);
        }

        await this.dbManager.withTransaction(async (tx) => {
            for (const [key, value] of rows) {
                await tx.query(UPSERT_TOKEN_SQL, [key, value]);
            }
        });

        // Only now is the rotation durable, so only now does memory move.
        for (const [key, value] of rows) {
            this.tokens[key] = value;
        }

        logger.info('TokenManager', 'Token refreshed successfully', {
            type,
            userId: identity?.userId,
            expiresInMinutes: Math.round(expiresInSeconds / 60)
        });

        return result.access_token;
    }

    /**
     * Guards against an implausibly short expires_in. Trusting one verbatim would
     * park the token permanently inside the refresh margin and restore the
     * every-five-minutes rotation this design exists to remove.
     */
    computeExpiresAt(expiresInSeconds) {
        const lifetimeMs = (Number(expiresInSeconds) || 0) * 1000;

        if (lifetimeMs < MIN_TOKEN_LIFETIME_MS) {
            logger.warn('TokenManager', 'Twitch reported an implausibly short token lifetime, applying floor', {
                reportedSeconds: expiresInSeconds,
                flooredToMinutes: Math.round(MIN_TOKEN_LIFETIME_MS / 60000)
            });
            return Date.now() + MIN_TOKEN_LIFETIME_MS;
        }

        return Date.now() + lifetimeMs;
    }

    requestNewTokens(type, refreshToken) {
        const postData = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.tokens.clientId,
            client_secret: this.tokens.clientSecret
        }).toString();

        const options = {
            hostname: 'id.twitch.tv',
            path: '/oauth2/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': postData.length
            }
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';

                logger.debug('TokenManager', 'Received response from token refresh endpoint', {
                    type,
                    statusCode: res.statusCode
                });

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    let result;
                    try {
                        result = JSON.parse(data);
                    } catch (error) {
                        logger.error('TokenManager', 'Token refresh failed - parse error', {
                            error: error.message,
                            stack: error.stack,
                            type,
                            responseData: data
                        });
                        reject(new Error(`Failed to parse Twitch API response: ${error.message}`));
                        return;
                    }

                    if (result.access_token && result.refresh_token) {
                        resolve(result);
                        return;
                    }

                    if (this.isDeadRefreshToken(result)) {
                        logger.error('TokenManager', 'MANUAL RE-AUTHORIZATION REQUIRED - the refresh token is no longer valid', {
                            type,
                            status: result.status,
                            twitchMessage: result.message
                        });
                    } else {
                        logger.error('TokenManager', 'Token refresh failed - invalid response', {
                            type,
                            error: result.message || 'Unknown error',
                            response: result
                        });
                    }

                    reject(new Error(
                        `Failed to refresh ${type} tokens: ${result.message || 'Unknown error'}`
                    ));
                });
            });

            req.on('error', (error) => {
                logger.error('TokenManager', 'Token refresh failed - network error', {
                    error: error.message,
                    stack: error.stack,
                    type
                });
                reject(new Error(`Network error during ${type} token refresh: ${error.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    isDeadRefreshToken(result) {
        return result.status === 400 || /invalid refresh token/i.test(result.message || '');
    }

    getBroadcasterToken() {
        logger.debug('TokenManager', 'Retrieving broadcaster token');
        return this.tokens.broadcasterAccessToken;
    }
}

module.exports = TokenManager;
module.exports.TOKEN_KEYS = TOKEN_KEYS;
