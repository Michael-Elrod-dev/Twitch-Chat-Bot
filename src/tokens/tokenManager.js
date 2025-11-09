// src/tokens/tokenManager.js

const https = require('https');
const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

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
        await this.checkAndRefreshTokens();
        this.isInitialized = true;
        logger.info('TokenManager', 'TokenManager initialized successfully');
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
            throw new Error('Unable to load tokens from database');
        }
    }

    async saveTokens() {
        try {
            logger.debug('TokenManager', 'Saving all tokens to database', {
                tokenCount: Object.keys(this.tokens).length
            });

            for (const [key, value] of Object.entries(this.tokens)) {
                await this.dbManager.query(`
                    UPDATE tokens
                    SET token_value = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE token_key = ?
                `, [value, key]);
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

            this.tokens[tokenKey] = tokenValue;
            await this.dbManager.query(`
                UPDATE tokens
                SET token_value = ?, updated_at = CURRENT_TIMESTAMP
                WHERE token_key = ?
            `, [tokenValue, tokenKey]);

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

    async validateToken(type = 'bot') {
        try {
            logger.debug('TokenManager', 'Validating token', { type });

            const token = type === 'bot' ? this.tokens.botAccessToken : this.tokens.broadcasterAccessToken;
            const response = await fetch(`${config.twitchAuthEndpoint}/validate`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                logger.warn('TokenManager', 'Token validation failed, refreshing token', {
                    type,
                    status: response.status,
                    statusText: response.statusText
                });

                await this.refreshToken(type);

                // After refresh, validate again to get the user ID
                const newResponse = await fetch(`${config.twitchAuthEndpoint}/validate`, {
                    headers: {
                        'Authorization': `Bearer ${this.tokens.botAccessToken}`
                    }
                });
                const newData = await newResponse.json();
                if (type === 'bot') {
                    await this.updateToken('botId', newData.user_id);
                }

                logger.info('TokenManager', 'Token refreshed and validated successfully', {
                    type,
                    userId: newData.user_id
                });
            } else {
                if (type === 'bot') {
                    await this.updateToken('botId', data.user_id);
                } else {
                    await this.updateToken('userId', data.user_id);
                }

                logger.info('TokenManager', 'Token validated successfully', {
                    type,
                    userId: data.user_id,
                    expiresIn: data.expires_in
                });
            }

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

    async refreshToken(type = 'bot') {
        logger.debug('TokenManager', 'Refreshing token', { type });

        const refreshToken = type === 'bot' ? this.tokens.botRefreshToken : this.tokens.broadcasterRefreshToken;
        const postData = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.tokens.clientId,
            client_secret: this.tokens.clientSecret,
        }).toString();

        const options = {
            hostname: 'id.twitch.tv',
            path: '/oauth2/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': postData.length,
            },
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

                res.on('end', async () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.access_token && result.refresh_token) {
                            if (type === 'bot') {
                                await this.updateToken('botAccessToken', result.access_token);
                                await this.updateToken('botRefreshToken', result.refresh_token);

                                // Validate the new token to get the bot ID
                                const validateResponse = await fetch(`${config.twitchAuthEndpoint}/validate`, {
                                    headers: {
                                        'Authorization': `Bearer ${result.access_token}`
                                    }
                                });
                                const validateData = await validateResponse.json();
                                await this.updateToken('botId', validateData.user_id);

                                logger.info('TokenManager', 'Bot token refreshed successfully', {
                                    userId: validateData.user_id
                                });
                            } else {
                                await this.updateToken('broadcasterAccessToken', result.access_token);
                                await this.updateToken('broadcasterRefreshToken', result.refresh_token);

                                logger.info('TokenManager', 'Broadcaster token refreshed successfully');
                            }
                            resolve(result.access_token);
                        } else {
                            const errorMsg = `Failed to refresh ${type} tokens: ${result.message || 'Unknown error'}`;
                            logger.error('TokenManager', 'Token refresh failed - invalid response', {
                                type,
                                error: result.message || 'Unknown error',
                                response: result
                            });
                            reject(errorMsg);
                        }
                    } catch (error) {
                        const errorMsg = `Failed to parse Twitch API response: ${error.message}`;
                        logger.error('TokenManager', 'Token refresh failed - parse error', {
                            error: error.message,
                            stack: error.stack,
                            type,
                            responseData: data
                        });
                        reject(errorMsg);
                    }
                });
            });

            req.on('error', (error) => {
                const errorMsg = `Network error during ${type} token refresh: ${error.message}`;
                logger.error('TokenManager', 'Token refresh failed - network error', {
                    error: error.message,
                    stack: error.stack,
                    type
                });
                reject(errorMsg);
            });

            req.write(postData);
            req.end();
        });
    }

    async checkAndRefreshTokens() {
        try {
            logger.debug('TokenManager', 'Checking and refreshing all tokens');

            await Promise.all([
                this.refreshToken('bot').catch(error => {
                    logger.error('TokenManager', 'Failed to refresh bot token', {
                        error: error.message || error,
                        stack: error.stack
                    });
                    throw new Error('Bot token refresh failed');
                }),
                this.refreshToken('broadcaster').catch(error => {
                    logger.error('TokenManager', 'Failed to refresh broadcaster token', {
                        error: error.message || error,
                        stack: error.stack
                    });
                    throw new Error('Broadcaster token refresh failed');
                })
            ]);

            // Add validation after refresh to get user IDs
            logger.debug('TokenManager', 'Validating refreshed tokens');
            await Promise.all([
                this.validateToken('bot'),
                this.validateToken('broadcaster')
            ]);

            logger.info('TokenManager', 'All tokens refreshed and validated successfully');
        } catch (error) {
            logger.error('TokenManager', 'Critical error refreshing tokens', {
                error: error.message,
                stack: error.stack
            });
            logger.warn('TokenManager', 'You may need to re-authenticate with Twitch');
        }
    }

    getConfig() {
        logger.debug('TokenManager', 'Generating bot configuration');
        return {
            identity: {
                username: 'almosthadai',
                password: 'oauth:' + this.tokens.botAccessToken,
            },
            channels: ['aimosthadme'],
            options: {
                clientId: this.tokens.clientId,
            },
        };
    }

    getBroadcasterToken() {
        logger.debug('TokenManager', 'Retrieving broadcaster token');
        return this.tokens.broadcasterAccessToken;
    }
}

module.exports = TokenManager;
