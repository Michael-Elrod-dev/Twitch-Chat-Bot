// src/redemptions/redemptionManager.js
class RedemptionManager {
    constructor(client, spotifyManager, apiClient) {
        console.log('* Initializing RedemptionManager');
        this.client = client;
        this.spotifyManager = spotifyManager;
        this.apiClient = apiClient;
        this.handlers = new Map();
    }

    registerHandler(rewardTitle, handler) {
        console.log(`* Registering handler for reward: ${rewardTitle}`);
        const existingHandler = this.handlers.get(rewardTitle.toLowerCase());
        if (existingHandler) {
            console.log(`* Replacing existing handler for: ${rewardTitle}`);
        }
        this.handlers.set(rewardTitle.toLowerCase(), handler);
        console.log(`* Current registered handlers: ${Array.from(this.handlers.keys()).join(', ')}`);
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
            await handler(event, this.client, this.spotifyManager, this.apiClient);
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