const fs = require('fs');
const path = require('path');
const https = require('https');

class TokenManager {
    constructor() {
        this.tokens = this.readTokens();
        console.log('* Setting up token refresh interval (30 days)');
        
        setInterval(() => {
            const lastRefreshFile = 'lastRefresh.txt';
            let lastRefresh;
            
            try {
                lastRefresh = new Date(fs.readFileSync(lastRefreshFile, 'utf8'));
            } catch {
                lastRefresh = new Date();
                fs.writeFileSync(lastRefreshFile, lastRefresh.toISOString());
            }

            const daysSinceRefresh = (new Date() - lastRefresh) / (1000 * 60 * 60 * 24);
            
            if (daysSinceRefresh >= 30) {
                console.log('* Performing scheduled token refresh');
                this.refreshToken()
                    .then(() => {
                        fs.writeFileSync(lastRefreshFile, new Date().toISOString());
                    })
                    .catch(error => console.error('Scheduled refresh failed:', error));
            }
        }, 24 * 60 * 60 * 1000);
    }


    readTokens() {
        const tokenFile = fs.readFileSync(path.join(__dirname, '../files/tokens.txt'), 'utf8');
        const tokens = {};
        tokenFile.split('\n').forEach(line => {
            const [key, value] = line.split(':');
            tokens[key] = value;
        });
        return tokens;
    }

    async refreshToken() {
        return new Promise((resolve, reject) => {
            const url = `https://twitchtokengenerator.com/api/refresh/${this.tokens.RefreshToken}`;
            
            https.get(url, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        if (!data) {
                            reject('Empty response from token refresh API');
                            return;
                        }

                        const result = JSON.parse(data);
                        if (result.success) {
                            const newContent = 
                                `AccessToken:${result.token}\n` +
                                `RefreshToken:${result.refresh}\n` +
                                `ClientID:${result.client_id}`;
                            
                            fs.writeFileSync('tokens.txt', newContent);
                            this.tokens = this.readTokens();
                            console.log('* Tokens refreshed successfully');
                            resolve(result.token);
                        } else {
                            reject(`Token refresh failed: ${result.message || 'Unknown error'}`);
                        }
                    } catch (error) {
                        reject(`Failed to parse API response: ${error.message}`);
                    }
                });
            }).on('error', (error) => {
                reject(`Network error during token refresh: ${error.message}`);
            });
        });
    }

    getConfig() {
        return {
            identity: {
                username: 'almosthadai',
                password: 'oauth:' + this.tokens.AccessToken
            },
            channels: [
                'aimosthadme',
            ],
            options: {
                clientId: this.tokens.ClientID
            }
        };
    }
}

module.exports = TokenManager;