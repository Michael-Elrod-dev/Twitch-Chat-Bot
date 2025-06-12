// src/models/aiManager.js
const config = require('../config/config');
const RateLimiter = require('./rateLimiter');
const ClaudeModel = require('./models/claudeModel');
const OpenAIModel = require('./models/openaiModel');

class AIManager {
    constructor() {
        this.dbManager = null;
        this.claudeModel = null;
        this.openaiModel = null;
        this.rateLimiter = null;
    }

    async init(dbManager, claudeApiKey, openaiApiKey) {
        this.dbManager = dbManager;
        this.claudeModel = new ClaudeModel(claudeApiKey);
        this.openaiModel = new OpenAIModel(openaiApiKey);
        this.rateLimiter = new RateLimiter(dbManager);
        console.log('✅ AIManager initialized');
    }

    async handleTextRequest(prompt, userId, userContext = {}) {
        // Check rate limits for Claude
        const rateLimitResult = await this.rateLimiter.checkRateLimit(userId, 'claude', userContext);
        
        if (!rateLimitResult.allowed) {
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        // Get response from Claude
        const response = await this.claudeModel.getTextResponse(prompt, userContext);
        
        if (response) {
            await this.rateLimiter.updateUsage(userId, 'claude');
            return {
                success: true,
                response: response
            };
        }

        return {
            success: false,
            message: "Sorry, I'm having trouble responding right now."
        };
    }

    async handleImageRequest(prompt, userId, userContext = {}) {
        // Check rate limits for OpenAI images
        const rateLimitResult = await this.rateLimiter.checkRateLimit(userId, 'openai_image', userContext);
        
        if (!rateLimitResult.allowed) {
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        // Generate image with OpenAI (placeholder for now)
        const response = await this.openaiModel.generateImage(prompt, userContext);
        
        if (response) {
            await this.rateLimiter.updateUsage(userId, 'openai_image');
            return {
                success: true,
                response: response
            };
        }

        return {
            success: false,
            message: "Sorry, I can't generate images right now."
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