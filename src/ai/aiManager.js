// src/ai/aiManager.js

const config = require('../config/config');
const RateLimiter = require('./rateLimiter');
const PromptBuilder = require('./promptBuilder');
const ContextBuilder = require('./contextBuilder');
const ClaudeModel = require('./models/claudeModel');
const logger = require('../logger/logger');

class AIManager {
    constructor() {
        this.dbManager = null;
        this.claudeModel = null;
        this.rateLimiter = null;
        this.promptBuilder = null;
        this.contextBuilder = null;
    }

    async init(dbManager, claudeApiKey) {
        this.dbManager = dbManager;
        this.claudeModel = new ClaudeModel(claudeApiKey);
        this.rateLimiter = new RateLimiter(dbManager);
        this.contextBuilder = new ContextBuilder(dbManager);
        this.promptBuilder = new PromptBuilder();
        logger.info('AIManager', 'AIManager initialized successfully');
    }

    async handleTextRequest(prompt, userId, streamId, userContext = {}) {
        logger.debug('AIManager', 'Processing text request', {
            userId,
            userName: userContext.userName,
            promptLength: prompt.length,
            streamId
        });

        // Check rate limits for Claude
        const rateLimitResult = await this.rateLimiter.checkRateLimit(userId, 'claude', streamId, userContext);

        if (!rateLimitResult.allowed) {
            logger.info('AIManager', 'Rate limit exceeded', {
                userId,
                userName: userContext.userName,
                reason: rateLimitResult.reason,
                streamCount: rateLimitResult.streamCount,
                streamLimit: rateLimitResult.streamLimit
            });
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        // Fetch context data for enhanced prompt
        const chatHistoryLimit = config.aiSettings.claude.chatHistoryLimit;
        const context = await this.contextBuilder.getAllContext(streamId, chatHistoryLimit);

        // Build enhanced prompt with context
        const enhancedPrompt = this.promptBuilder.buildUserMessage(
            prompt,
            userContext.userName,
            context.streamContext,
            context.chatHistory,
            context.userRoles
        );

        logger.debug('AIManager', 'Enhanced prompt built', {
            chatHistoryCount: context.chatHistory.length,
            hasStreamContext: !!context.streamContext,
            broadcaster: context.userRoles.broadcaster,
            modsCount: context.userRoles.mods.length
        });

        // Log full prompt in debug mode for testing/verification
        logger.debug('AIManager', 'Full prompt being sent to Claude:', {
            fullPrompt: enhancedPrompt
        });

        // Get response from Claude with enhanced prompt
        const response = await this.claudeModel.getTextResponse(enhancedPrompt, userContext);

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

            logger.info('AIManager', 'Text request completed successfully', {
                userId,
                userName: userContext.userName,
                promptLength: prompt.length,
                responseLength: response.length,
                streamCount: usageStats.streamCount,
                streamLimit: userLimits.streamLimit
            });

            return {
                success: true,
                response: finalResponse
            };
        }

        logger.error('AIManager', 'Failed to get AI response', {
            userId,
            userName: userContext.userName,
            promptLength: prompt.length
        });

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
