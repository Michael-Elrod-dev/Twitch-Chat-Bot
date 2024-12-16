const fs = require('fs');
const path = require('path');
const https = require('https');

class TokenManager {
    constructor() {
        this.tokens = this.readTokens();
        console.log('* Checking token validity on startup...');
        this.checkAndRefreshTokens();
    }

    readTokens() {
        try {
            const tokenFile = fs.readFileSync(path.join(__dirname, '../../files/tokens.json'), 'utf8');
            return JSON.parse(tokenFile);
        } catch (error) {
            console.error('* Error reading tokens file:', error);
            throw new Error('Unable to read tokens.json. Make sure the file exists in the files directory.');
        }
    }

    saveTokens() {
        try {
            fs.writeFileSync(
                path.join(__dirname, '../../files/tokens.json'),
                JSON.stringify(this.tokens, null, 2)
            );
        } catch (error) {
            console.error('* Error saving tokens:', error);
        }
    }

    async validateToken(type = 'bot') {
        try {
            const token = type === 'bot' ? this.tokens.botAccessToken : this.tokens.broadcasterAccessToken;
            const response = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                await this.refreshToken(type);
                return true;
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

                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.access_token && result.refresh_token) {
                            if (type === 'bot') {
                                this.tokens.botAccessToken = result.access_token;
                                this.tokens.botRefreshToken = result.refresh_token;
                            } else {
                                this.tokens.broadcasterAccessToken = result.access_token;
                                this.tokens.broadcasterRefreshToken = result.refresh_token;
                            }
                            this.saveTokens();
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
        console.log('* Refreshing tokens on startup...');
        try {
            await Promise.all([
                this.refreshToken('bot').catch(error => {
                    console.error('Failed to refresh bot token:', error);
                    throw new Error('Bot token refresh failed');
                }),
                this.refreshToken('broadcaster').catch(error => {
                    console.error('Failed to refresh broadcaster token:', error);
                    throw new Error('Broadcaster token refresh failed');
                })
            ]);
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
