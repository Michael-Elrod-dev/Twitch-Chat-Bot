// redemptionManager.js
class RedemptionManager {
    constructor(client, spotifyManager, apiClient) {
        this.client = client;
        this.spotifyManager = spotifyManager;
        this.apiClient = apiClient;
        this.handlers = new Map();
    }

    registerHandler(rewardTitle, handler) {
        this.handlers.set(rewardTitle.toLowerCase(), handler);
    }

    async handleRedemption(event) {
        const handler = this.handlers.get(event.rewardTitle.toLowerCase());
        if (handler) {
            try {
                // Pass apiClient to handler
                await handler(event, this.client, this.spotifyManager, this.apiClient);
            } catch (error) {
                console.error(`Error handling redemption ${event.rewardTitle}:`, error);
            }
        }
    }
}

module.exports = RedemptionManager;