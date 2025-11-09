// src/messages/redemptionHandler.js

const logger = require('../logger/logger');

class RedemptionHandler {
    constructor(viewerManager, redemptionManager) {
        this.viewerManager = viewerManager;
        this.redemptionManager = redemptionManager;
    }

    async handleRedemption(payload, bot) {
        try {
            if (!payload.event) return;

            const event = {
                rewardTitle: payload.event.reward.title,
                rewardId: payload.event.reward.id,
                userDisplayName: payload.event.user_login,
                userId: payload.event.user_id,
                input: payload.event.user_input,
                status: payload.event.status,
                id: payload.event.id,
                broadcasterId: payload.event.broadcaster_user_id,
                broadcasterDisplayName: payload.event.broadcaster_user_login
            };

            logger.info('RedemptionHandler', 'Processing channel point redemption', {
                userId: event.userId,
                userName: event.userDisplayName,
                rewardTitle: event.rewardTitle,
                rewardId: event.rewardId,
                input: event.input
            });

            // Track redemption in analytics
            await bot.analyticsManager.trackChatMessage(
                event.userDisplayName,
                event.userId,
                bot.currentStreamId,
                event.input || event.rewardTitle,
                'redemption',
                {} // userContext - redemptions don't have mod/subscriber info in this context
            );

            await this.redemptionManager.handleRedemption(event);

            logger.info('RedemptionHandler', 'Redemption processed successfully', {
                userId: event.userId,
                userName: event.userDisplayName,
                rewardTitle: event.rewardTitle
            });
        } catch (error) {
            logger.error('RedemptionHandler', 'Error handling redemption', {
                error: error.message,
                stack: error.stack
            });
        }
    }
}

module.exports = RedemptionHandler;
