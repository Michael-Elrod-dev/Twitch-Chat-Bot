// src/tokens/twitchAPI.js

const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

class TwitchAPI {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
        logger.debug('TwitchAPI', 'TwitchAPI instance created');
    }

    async getChannelId(username) {
        try {
            logger.debug('TwitchAPI', 'Fetching channel ID', { username });

            const response = await fetch(`${config.twitchApiEndpoint}/users?login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.AccessToken}`,
                    'Client-Id': this.tokenManager.tokens.ClientID
                }
            });

            logger.debug('TwitchAPI', 'Received response for channel ID', {
                username,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                const channelId = data.data[0].id;
                logger.info('TwitchAPI', 'Successfully retrieved channel ID', {
                    username,
                    channelId
                });
                return channelId;
            }

            logger.warn('TwitchAPI', 'User not found', { username });
            throw new Error('User not found');
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get channel ID', {
                error: error.message,
                stack: error.stack,
                username
            });
            throw error;
        }
    }

    async getStreamByUserName(username) {
        try {
            logger.debug('TwitchAPI', 'Fetching stream information', { username });

            const response = await fetch(`${config.twitchApiEndpoint}/streams?user_login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            logger.debug('TwitchAPI', 'Received response for stream', {
                username,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                const streamInfo = {
                    startDate: data.data[0].started_at,
                    viewer_count: data.data[0].viewer_count
                };
                logger.info('TwitchAPI', 'Stream is live', {
                    username,
                    viewerCount: streamInfo.viewer_count,
                    startDate: streamInfo.startDate
                });
                return streamInfo;
            }

            logger.debug('TwitchAPI', 'Stream not found or offline', { username });
            return null;
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get stream information', {
                error: error.message,
                stack: error.stack,
                username
            });
            throw error;
        }
    }

    async getUserByName(username) {
        try {
            logger.debug('TwitchAPI', 'Fetching user information', { username });

            const response = await fetch(`${config.twitchApiEndpoint}/users?login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            logger.debug('TwitchAPI', 'Received response for user', {
                username,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                logger.info('TwitchAPI', 'Successfully retrieved user information', {
                    username,
                    userId: data.data[0].id,
                    displayName: data.data[0].display_name
                });
                return data.data[0];
            }

            logger.debug('TwitchAPI', 'User not found', { username });
            return null;
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get user information', {
                error: error.message,
                stack: error.stack,
                username
            });
            throw error;
        }
    }

    async getCustomRewards(broadcasterId) {
        try {
            logger.debug('TwitchAPI', 'Fetching custom rewards', { broadcasterId });

            const response = await fetch(`${config.twitchApiEndpoint}/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            logger.debug('TwitchAPI', 'Received response for custom rewards', {
                broadcasterId,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data) {
                logger.info('TwitchAPI', 'Successfully retrieved custom rewards', {
                    broadcasterId,
                    rewardCount: data.data.length
                });
                return data.data;
            }

            logger.debug('TwitchAPI', 'No custom rewards found', { broadcasterId });
            return [];
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get custom rewards', {
                error: error.message,
                stack: error.stack,
                broadcasterId
            });
            throw error;
        }
    }

    async updateCustomReward(broadcasterId, rewardId, updates) {
        try {
            logger.debug('TwitchAPI', 'Updating custom reward', {
                broadcasterId,
                rewardId,
                updates
            });

            const response = await fetch(`${config.twitchApiEndpoint}/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updates)
            });

            logger.debug('TwitchAPI', 'Received response for reward update', {
                broadcasterId,
                rewardId,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                logger.info('TwitchAPI', 'Successfully updated custom reward', {
                    broadcasterId,
                    rewardId,
                    updates
                });
                return data.data[0];
            }

            logger.error('TwitchAPI', 'Failed to update reward - no data returned', {
                broadcasterId,
                rewardId,
                responseData: data
            });
            throw new Error('Failed to update reward');
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to update custom reward', {
                error: error.message,
                stack: error.stack,
                broadcasterId,
                rewardId,
                updates
            });
            throw error;
        }
    }

    async getChannelInfo(broadcasterId) {
        try {
            logger.debug('TwitchAPI', 'Fetching channel information', { broadcasterId });

            const response = await fetch(`${config.twitchApiEndpoint}/channels?broadcaster_id=${broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            logger.debug('TwitchAPI', 'Received response for channel info', {
                broadcasterId,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data && data.data[0]) {
                logger.info('TwitchAPI', 'Successfully retrieved channel information', {
                    broadcasterId,
                    broadcasterName: data.data[0].broadcaster_name,
                    gameId: data.data[0].game_id
                });
                return data.data[0];
            }

            logger.debug('TwitchAPI', 'Channel info not found', { broadcasterId });
            return null;
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get channel information', {
                error: error.message,
                stack: error.stack,
                broadcasterId
            });
            throw error;
        }
    }

    async getChatters(broadcasterId, moderatorId) {
        try {
            logger.debug('TwitchAPI', 'Fetching chatters', {
                broadcasterId,
                moderatorId
            });

            const response = await fetch(`${config.twitchApiEndpoint}/chat/chatters?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`, {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': this.tokenManager.tokens.clientId
                }
            });

            logger.debug('TwitchAPI', 'Received response for chatters', {
                broadcasterId,
                moderatorId,
                status: response.status,
                statusText: response.statusText
            });

            const data = await response.json();
            if (data.data) {
                logger.info('TwitchAPI', 'Successfully retrieved chatters', {
                    broadcasterId,
                    moderatorId,
                    chatterCount: data.data.length
                });
                return data.data; // Returns array of {user_id, user_login, user_name}
            }

            logger.debug('TwitchAPI', 'No chatters found', {
                broadcasterId,
                moderatorId
            });
            return [];
        } catch (error) {
            logger.error('TwitchAPI', 'Failed to get chatters', {
                error: error.message,
                stack: error.stack,
                broadcasterId,
                moderatorId
            });
            return [];
        }
    }
}

module.exports = TwitchAPI;
