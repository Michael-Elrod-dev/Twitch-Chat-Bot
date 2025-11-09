// src/ai/aiManager.js

const config = require('../config/config');
const RateLimiter = require('./rateLimiter');
const ClaudeModel = require('./models/claudeModel');

class AIManager {
    constructor() {
        this.dbManager = null;
        this.claudeModel = null;
        this.rateLimiter = null;
    }

    async init(dbManager, claudeApiKey) {
        this.dbManager = dbManager;
        this.claudeModel = new ClaudeModel(claudeApiKey);
        this.rateLimiter = new RateLimiter(dbManager);
        console.log('✅ AIManager initialized');
    }

    async handleTextRequest(prompt, userId, streamId, userContext = {}) {
        // Check rate limits for Claude
        const rateLimitResult = await this.rateLimiter.checkRateLimit(userId, 'claude', streamId, userContext);

        if (!rateLimitResult.allowed) {
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        // Get response from Claude
        const response = await this.claudeModel.getTextResponse(prompt, userContext);

        if (response) {
            await this.rateLimiter.updateUsage(userId, 'claude', streamId);

            // Get updated usage stats for display
            const usageStats = await this.rateLimiter.getUserStats(userId, 'claude', streamId);
            const userLimits = this.rateLimiter.getUserLimits('claude', userContext);

            // Add usage counter (unless broadcaster has unlimited)
            let finalResponse = response;
            if (!userContext.isBroadcaster && userLimits.streamLimit < 999999) {
                finalResponse = `(${usageStats.streamCount}/${userLimits.streamLimit}) ${response}`;
            }

            return {
                success: true,
                response: finalResponse
            };
        }

        return {
            success: false,
            message: config.errorMessages.ai.unavailable
        };
    }


    // Helper methods to check triggers
    shouldTriggerText(message) {
        const lowerMessage = message.toLowerCase();
        return config.aiTriggers.text.some(trigger =>
            lowerMessage.includes(trigger) || lowerMessage.startsWith(trigger)
        );
    }


    extractPrompt(message, triggerType) {
        let prompt = message;

        if (triggerType === 'text') {
            // Remove bot mentions - just the two we still use
            prompt = prompt.replace(/@almosthadai/gi, '').trim();
            prompt = prompt.replace(/almosthadai/gi, '').trim();
        }

        return prompt || null;
    }
}

module.exports = AIManager;
