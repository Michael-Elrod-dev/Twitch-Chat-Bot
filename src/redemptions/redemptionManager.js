// src/redemptions/redemptionManager.js
class RedemptionManager {
    constructor(apiClient, spotifyManager) {
        this.apiClient = apiClient;
        this.spotifyManager = spotifyManager;
        this.handlers = new Map();
    }

    registerHandler(rewardTitle, handler) {
        const existingHandler = this.handlers.get(rewardTitle.toLowerCase());
        if (existingHandler) {
            console.log(`* Replacing existing handler for: ${rewardTitle}`);
        }
        this.handlers.set(rewardTitle.toLowerCase(), handler);
        console.log(`✅ Current registered handlers: ${Array.from(this.handlers.keys()).join(', ')}`);
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
            await handler(event, this.apiClient, this.spotifyManager, this.apiClient);
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