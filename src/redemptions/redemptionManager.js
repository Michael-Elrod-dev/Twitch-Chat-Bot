// src/redemptions/redemptionManager.js
const fetch = require('node-fetch');
const config = require('../config/config');

class RedemptionManager {
    constructor(twitchBot, spotifyManager) {
        this.twitchBot = twitchBot;
        this.spotifyManager = spotifyManager;
        this.handlers = new Map();
    }

    registerHandler(rewardTitle, handler) {
        this.handlers.set(rewardTitle.toLowerCase(), handler);
        console.log(`✅ Registered ${rewardTitle} handler`);
    }

    async handleRedemption(event) {
        const timestamp = new Date().toISOString();
        const handler = this.handlers.get(event.rewardTitle.toLowerCase());

        if (!handler) {
            console.log(`* No handler found for reward: ${event.rewardTitle}`);
            return;
        }

        try {
            await handler(event, this.twitchBot, this.spotifyManager, this.twitchBot);
            console.log(`* Executed handler for: ${event.rewardTitle}`);
        } catch (error) {
            console.error('* Handler execution failed:', {
                timestamp,
                reward: event.rewardTitle,
                user: event.userDisplayName,
                error: error.message,
                stack: error.stack,
                eventData: {
                    rewardId: event.rewardId,
                    status: event.status,
                    input: event.input
                }
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
            console.error('Error updating redemption status:', error);
            throw error;
        }
    }
}

module.exports = RedemptionManager;