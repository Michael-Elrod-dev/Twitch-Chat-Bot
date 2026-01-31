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
        this.redisManager = null;
        this.claudeModel = null;
        this.rateLimiter = null;
        this.promptBuilder = null;
        this.contextBuilder = null;
    }

    async init(dbManager, claudeApiKey, redisManager = null) {
        this.dbManager = dbManager;
        this.redisManager = redisManager;
        this.claudeModel = new ClaudeModel(claudeApiKey);
        this.rateLimiter = new RateLimiter(dbManager, redisManager);
        this.contextBuilder = new ContextBuilder(dbManager);
        this.promptBuilder = new PromptBuilder();
        logger.info('AIManager', 'AIManager initialized successfully', {
            redisEnabled: !!redisManager
        });
    }

    async handleTextRequest(prompt, userId, streamId, userContext = {}) {
        logger.debug('AIManager', 'Processing text request', {
            userId,
            userName: userContext.userName,
            promptLength: prompt.length,
            streamId
        });

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

        const chatHistoryLimit = config.aiSettings.claude.chatHistoryLimits.regularChat;
        const context = await this.contextBuilder.getAllContext(streamId, chatHistoryLimit);

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

        logger.debug('AIManager', 'Full prompt being sent to Claude:', {
            fullPrompt: enhancedPrompt
        });

        const chatSystemPrompt = require('./prompts/chatPrompt');

        const response = await this.claudeModel.getTextResponse(enhancedPrompt, userContext, chatSystemPrompt);

        if (response) {
            await this.rateLimiter.updateUsage(userId, 'claude', streamId);

            const usageStats = await this.rateLimiter.getUserStats(userId, 'claude', streamId);
            const userLimits = this.rateLimiter.getUserLimits('claude', userContext);

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


    shouldTriggerText(message) {
        const lowerMessage = message.toLowerCase();
        return config.aiTriggers.text.some(trigger =>
            lowerMessage.includes(trigger) || lowerMessage.startsWith(trigger)
        );
    }


    extractPrompt(message, triggerType) {
        let prompt = message;

        if (triggerType === 'text') {
            prompt = prompt.replace(/@almosthadai/gi, '').trim();
            prompt = prompt.replace(/almosthadai/gi, '').trim();
        }

        return prompt || null;
    }

    async handleGameCommand(gameType, targetUserId, targetUsername, streamId, requestingUserContext = {}) {
        logger.debug('AIManager', 'Processing game command', {
            gameType,
            targetUserId,
            targetUsername,
            streamId,
            requestedBy: requestingUserContext.userName
        });

        const rateLimitResult = await this.rateLimiter.checkRateLimit(
            requestingUserContext.userId,
            'claude',
            streamId,
            requestingUserContext
        );

        if (!rateLimitResult.allowed) {
            logger.info('AIManager', 'Rate limit exceeded for game command', {
                gameType,
                userId: requestingUserContext.userId,
                userName: requestingUserContext.userName,
                reason: rateLimitResult.reason
            });
            return {
                success: false,
                message: rateLimitResult.message
            };
        }

        const chatHistoryLimit = config.aiSettings.claude.chatHistoryLimits[gameType] || 0;
        const [context, userProfile] = await Promise.all([
            this.contextBuilder.getAllContext(streamId, chatHistoryLimit),
            this.contextBuilder.getUserProfile(targetUserId)
        ]);

        const chatPrompt = require('./prompts/chatPrompt');

        let gamePrompt;
        try {
            gamePrompt = require(`./prompts/${gameType}Prompt`);
        } catch (error) {
            logger.error('AIManager', 'Failed to load game prompt', {
                gameType,
                error: error.message
            });
            return {
                success: false,
                message: 'Game type not available.'
            };
        }

        const combinedSystemPrompt = chatPrompt + '\n\n' + gamePrompt;

        const userPrompt = this.promptBuilder.buildGamePrompt(
            targetUsername,
            userProfile,
            context.streamContext,
            context.chatHistory,
            context.userRoles
        );

        logger.debug('AIManager', 'Game prompt built', {
            gameType,
            hasUserProfile: !!userProfile,
            targetUsername,
            chatHistoryCount: context.chatHistory.length,
            systemPromptLength: combinedSystemPrompt.length
        });

        logger.debug('AIManager', 'Game prompts being sent to Claude:', {
            systemPrompt: combinedSystemPrompt,
            userPrompt: userPrompt
        });

        const response = await this.claudeModel.getTextResponse(userPrompt, requestingUserContext, combinedSystemPrompt);

        if (response) {
            await this.rateLimiter.updateUsage(requestingUserContext.userId, 'claude', streamId);

            const usageStats = await this.rateLimiter.getUserStats(requestingUserContext.userId, 'claude', streamId);
            const userLimits = this.rateLimiter.getUserLimits('claude', requestingUserContext);

            logger.info('AIManager', 'Game command completed successfully', {
                gameType,
                targetUsername,
                requestedBy: requestingUserContext.userName,
                responseLength: response.length,
                streamCount: usageStats.streamCount,
                streamLimit: userLimits.streamLimit
            });

            return {
                success: true,
                response: response
            };
        }

        logger.error('AIManager', 'Failed to get AI response for game command', {
            gameType,
            targetUsername,
            requestedBy: requestingUserContext.userName
        });

        return {
            success: false,
            message: config.errorMessages.ai.unavailable
        };
    }
}

module.exports = AIManager;
