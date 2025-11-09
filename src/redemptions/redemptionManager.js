// src/redemptions/redemptionManager.js

const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

class RedemptionManager {
    constructor(twitchBot, spotifyManager) {
        this.twitchBot = twitchBot;
        this.spotifyManager = spotifyManager;
        this.handlers = new Map();
    }

    registerHandler(rewardTitle, handler) {
        this.handlers.set(rewardTitle.toLowerCase(), handler);
        logger.info('RedemptionManager', 'Handler registered', { rewardTitle });
    }

    async handleRedemption(event) {
        const handler = this.handlers.get(event.rewardTitle.toLowerCase());

        if (!handler) {
            logger.warn('RedemptionManager', 'No handler found for reward', {
                rewardTitle: event.rewardTitle,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
            return;
        }

        try {
            await handler(event, this.twitchBot, this.spotifyManager, this.twitchBot);
            logger.info('RedemptionManager', 'Handler executed successfully', {
                rewardTitle: event.rewardTitle,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
        } catch (error) {
            logger.error('RedemptionManager', 'Handler execution failed', {
                error: error.message,
                stack: error.stack,
                rewardTitle: event.rewardTitle,
                userDisplayName: event.userDisplayName,
                rewardId: event.rewardId,
                status: event.status,
                input: event.input
            });
        }
    }

    async updateRedemptionStatus(broadcasterId, rewardId, redemptionIds, status) {
        try {
            const response = await fetch(`${config.twitchApiEndpoint}/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&reward_id=${rewardId}&id=${redemptionIds[0]}`, {
                method: 'PATCH',
                headers: {
                    'Client-Id': this.twitchBot.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.twitchBot.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: status
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Failed to update redemption status: ${response.status} - ${JSON.stringify(errorData)}`);
            }
        } catch (error) {
            logger.error('RedemptionManager', 'Failed to update redemption status', {
                error: error.message,
                stack: error.stack,
                broadcasterId,
                rewardId,
                status
            });
            throw error;
        }
    }
}

module.exports = RedemptionManager;
