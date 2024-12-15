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
                            this.tokens.lastRefreshDate = new Date().toISOString();
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
                this.refreshToken('bot'),
                this.refreshToken('broadcaster')
            ]);
        } catch (error) {
            console.error('* Error refreshing tokens:', error);
            console.error('* Detailed error:', error.message);
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
