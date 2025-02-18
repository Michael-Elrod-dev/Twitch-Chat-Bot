// src/redemptions/redemptionManager.js
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
        console.log(`* Processing redemption event at ${timestamp} for: ${event.rewardTitle}`, {
            user: event.userDisplayName,
            rewardId: event.rewardId,
            status: event.status
        });
        
        const handler = this.handlers.get(event.rewardTitle.toLowerCase());
        
        if (!handler) {
            console.log(`* No handler found for reward: ${event.rewardTitle}`);
            return;
        }

        try {
            console.log(`* Executing handler for: ${event.rewardTitle}`);
            await handler(event, this.twitchBot, this.spotifyManager, this.twitchBot);
            console.log(`* Handler completed successfully for: ${event.rewardTitle}`);
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
}

module.exports = RedemptionManager;