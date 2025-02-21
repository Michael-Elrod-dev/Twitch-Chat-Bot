// src/messages/redemptionHandler.js
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
    
            // Track redemption in analytics
            await bot.analyticsManager.trackChatMessage(
                event.userDisplayName,
                event.userId,
                bot.currentStreamId,
                event.input || event.rewardTitle,
                'redemption'
            );
            
            await this.redemptionManager.handleRedemption(event);
        } catch (error) {
            console.error('❌ Error handling redemption:', error);
        }
    }
}

module.exports = RedemptionHandler;