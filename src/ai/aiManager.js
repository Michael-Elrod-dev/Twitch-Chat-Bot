// src/ai/aiManager.js

const config = require('../config/config');
const RateLimiter = require('./rateLimiter');
const ClaudeModel = require('./models/claudeModel');
const OpenAIModel = require('./models/openaiModel');
const DiscordUploader = require('./discordUploader');

class AIManager {
    constructor() {
        this.dbManager = null;
        this.claudeModel = null;
        this.openaiModel = null;
        this.rateLimiter = null;
        this.discordUploader = null;
    }

    async init(dbManager, claudeApiKey, openaiApiKey) {
        this.dbManager = dbManager;
        this.claudeModel = new ClaudeModel(claudeApiKey);
        this.openaiModel = new OpenAIModel(openaiApiKey);
        this.rateLimiter = new RateLimiter(dbManager);
        this.discordUploader = new DiscordUploader(config.discordWebhookUrl);
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
            message: 'Sorry, I\'m having trouble responding right now.'
        };
    }

    async handleImageRequest(prompt, userId, streamId, userContext = {}) {
        // Check rate limits for OpenAI images
        const rateLimitResult = await this.rateLimiter.checkRateLimit(userId, 'openai_image', streamId, userContext);

        if (!rateLimitResult.allowed) {
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        // Generate image with DALL-E 3
        const openaiImageUrl = await this.openaiModel.generateImage(prompt, userContext);

        if (openaiImageUrl) {
            // Upload to Discord and get CDN URL
            const discordImageUrl = await this.discordUploader.uploadImage(openaiImageUrl, userContext.username || 'Unknown', prompt);

            if (discordImageUrl) {
                await this.rateLimiter.updateUsage(userId, 'openai_image', streamId);

                // Get updated usage stats for display
                const usageStats = await this.rateLimiter.getUserStats(userId, 'openai_image', streamId);
                const userLimits = this.rateLimiter.getUserLimits('openai_image', userContext);

                // Add usage counter (unless broadcaster has unlimited)
                let finalResponse = `Here's your image: ${discordImageUrl}`;
                if (!userContext.isBroadcaster && userLimits.streamLimit < 999999) {
                    finalResponse = `(${usageStats.streamCount}/${userLimits.streamLimit}) Here's your image: ${discordImageUrl}`;
                }

                return {
                    success: true,
                    response: finalResponse
                };
            }
        }

        return {
            success: false,
            message: 'Sorry, I can\'t generate images right now.'
        };
    }

    // Helper methods to check triggers
    shouldTriggerText(message) {
        const lowerMessage = message.toLowerCase();
        return config.aiTriggers.text.some(trigger =>
            lowerMessage.includes(trigger) || lowerMessage.startsWith(trigger)
        );
    }

    shouldTriggerImage(message) {
        const lowerMessage = message.toLowerCase();
        return config.aiTriggers.image.some(trigger => lowerMessage.startsWith(trigger));
    }

    extractPrompt(message, triggerType) {
        let prompt = message;

        if (triggerType === 'text') {
            // Remove bot mentions - just the two we still use
            prompt = prompt.replace(/@almosthadai/gi, '').trim();
            prompt = prompt.replace(/almosthadai/gi, '').trim();
        } else if (triggerType === 'image') {
            // Remove image command triggers
            config.aiTriggers.image.forEach(trigger => {
                if (prompt.toLowerCase().startsWith(trigger)) {
                    prompt = prompt.substring(trigger.length).trim();
                }
            });
        }

        return prompt || null;
    }
}

module.exports = AIManager;
