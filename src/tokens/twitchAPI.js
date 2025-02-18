// src/tokens/twitchAPI.js
const config = require('../config/config');

class TwitchAPI {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
    }

    async getChannelId(username) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/users?login=${username}`, {
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
            console.error('❌ Failed to get channel ID:', error);
            throw error;
        }
    }

    async getStreamByUserName(username) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/streams?user_login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });
    
            const data = await response.json();
            if (data.data && data.data[0]) {
                return {
                    startDate: data.data[0].started_at
                };
            }
            return null;
        } catch (error) {
            console.error('❌ Failed to get stream:', error);
            throw error;
        }
    }
    
    async getUserByName(username) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/users?login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                return data.data[0];
            }
            return null;
        } catch (error) {
            console.error('❌ Failed to get user:', error);
            throw error;
        }
    }

    async getCustomRewards(broadcasterId) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            const data = await response.json();
            if (data.data) {
                return data.data;
            }
            return [];
        } catch (error) {
            console.error('❌ Failed to get custom rewards:', error);
            throw error;
        }
    }

    async updateCustomReward(broadcasterId, rewardId, updates) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updates)
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                return data.data[0];
            }
            throw new Error('❌ Failed to update reward');
        } catch (error) {
            console.error('❌ Failed to update custom reward:', error);
            throw error;
        }
    }
}

module.exports = TwitchAPI;