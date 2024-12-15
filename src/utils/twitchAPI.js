// src/twitchAPI.js
const fetch = require('node-fetch');

class TwitchAPI {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
    }

    async getChannelId(username) {
        try {
            const response = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.AccessToken}`,
                    'Client-Id': this.tokenManager.tokens.ClientID
                }
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                return data.data[0].id;
            }
            throw new Error('User not found');
        } catch (error) {
            console.error('Failed to get channel ID:', error);
            throw error;
        }
    }
}

module.exports = TwitchAPI;