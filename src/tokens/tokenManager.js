// src/tokens/tokenManager.js
const https = require('https');
const config = require('../config/config');

class TokenManager {
    constructor() {
        this.dbManager = null;
        this.tokens = {};
        this.isInitialized = false;
    }

    async init(dbManager) {
        this.dbManager = dbManager
        await this.loadTokensFromDatabase();
        await this.checkAndRefreshTokens();
        this.isInitialized = true;
    }

    async loadTokensFromDatabase() {
        try {
            const rows = await this.dbManager.query('SELECT token_key, token_value FROM tokens');
            this.tokens = {};
            
            for (const row of rows) {
                this.tokens[row.token_key] = row.token_value;
            }
            
            console.log('✅ Loaded tokens from database');
        } catch (error) {
            console.error('❌ Error loading tokens from database:', error);
            throw new Error('Unable to load tokens from database');
        }
    }

    async saveTokens() {
        try {
            for (const [key, value] of Object.entries(this.tokens)) {
                await this.dbManager.query(`
                    UPDATE tokens 
                    SET token_value = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE token_key = ?
                `, [value, key]);
            }
        } catch (error) {
            console.error('❌ Error saving tokens to database:', error);
            throw error;
        }
    }

    async updateToken(tokenKey, tokenValue) {
        try {
            this.tokens[tokenKey] = tokenValue;
            await this.dbManager.query(`
                UPDATE tokens 
                SET token_value = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE token_key = ?
            `, [tokenValue, tokenKey]);
        } catch (error) {
            console.error(`❌ Error updating token ${tokenKey}:`, error);
            throw error;
        }
    }

    getChannelName() {
        return config.channelName;
    }

    async validateToken(type = 'bot') {
        try {
            const token = type === 'bot' ? this.tokens.botAccessToken : this.tokens.broadcasterAccessToken;
            const response = await fetch(`${config.twitchAuthEndpoint}/validate`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const data = await response.json();
            
            if (!response.ok) {
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
            } else {
                if (type === 'bot') {
                    await this.updateToken('botId', data.user_id);
                } else {
                    await this.updateToken('userId', data.user_id);
                }
            }
            
            return true;
        } catch (error) {
            console.error(`Token validation failed for ${type}:`, error);
            return false;
        }
    }

    async refreshToken(type = 'bot') {
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
                            } else {
                                await this.updateToken('broadcasterAccessToken', result.access_token);
                                await this.updateToken('broadcasterRefreshToken', result.refresh_token);
                            }
                            resolve(result.access_token);
                        } else {
                            reject(`* Failed to refresh ${type} tokens: ${result.message || 'Unknown error'}`);
                        }
                    } catch (error) {
                        reject(`* Failed to parse Twitch API response: ${error.message}`);
                    }
                });
            });
    
            req.on('error', (error) => {
                reject(`* Network error during ${type} token refresh: ${error.message}`);
            });
    
            req.write(postData);
            req.end();
        });
    }

    async checkAndRefreshTokens() {
        try {
            await Promise.all([
                this.refreshToken('bot').catch(error => {
                    console.error('❌ Failed to refresh bot token:', error);
                    throw new Error('Bot token refresh failed');
                }),
                this.refreshToken('broadcaster').catch(error => {
                    console.error('❌ Failed to refresh broadcaster token:', error);
                    throw new Error('Broadcaster token refresh failed');
                })
            ]);
    
            // Add validation after refresh to get user IDs
            await Promise.all([
                this.validateToken('bot'),
                this.validateToken('broadcaster')
            ]);
    
            console.log('✅ Tokens refreshed');
        } catch (error) {
            console.error('* Critical error refreshing tokens:', error);
            console.log('* You may need to re-authenticate with Twitch');
        }
    }

    getConfig() {
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
        return this.tokens.broadcasterAccessToken;
    }
}

module.exports = TokenManager;