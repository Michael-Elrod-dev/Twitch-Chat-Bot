// src/messages/chatMessageHandler.js

const config = require('../config/config');
const logger = require('../logger/logger');

const AI_ENABLED_CACHE_KEY = 'cache:settings:aiEnabled';

class ChatMessageHandler {
    constructor(viewerManager, commandManager, emoteManager, aiManager, redisManager = null) {
        this.viewerManager = viewerManager;
        this.commandManager = commandManager;
        this.emoteManager = emoteManager;
        this.aiManager = aiManager;
        this.redisManager = redisManager;
    }

    getCacheManager() {
        if (this.redisManager && this.redisManager.connected()) {
            return this.redisManager.getCacheManager();
        }
        return null;
    }

    async handleChatMessage(payload, bot) {
        try {
            if (!payload.event) return;

            const event = payload.event;
            if (event.chatter_user_id === bot.tokenManager.tokens.botId) return;

            logger.debug('ChatMessageHandler', 'Processing chat message', {
                userId: event.chatter_user_id,
                userName: event.chatter_user_name,
                message: event.message.text
            });

            const isBroadcaster = event.badges?.some(badge => badge.set_id === 'broadcaster') || false;
            const isMod = event.badges?.some(badge => badge.set_id === 'moderator') || false;
            const isSubscriber = event.badges?.some(badge => badge.set_id === 'subscriber') || false;
            const isVip = event.badges?.some(badge => badge.set_id === 'vip') || false;

            const userContext = {
                userName: event.chatter_user_name,
                isMod: isMod,
                isSubscriber: isSubscriber,
                isVip: isVip,
                isBroadcaster: isBroadcaster
            };

            const context = {
                username: event.chatter_user_name,
                userId: event.chatter_user_id,
                mod: isMod,
                badges: {
                    broadcaster: isBroadcaster
                },
                'custom-reward-id': event.channel_points_custom_reward_id
            };

            if (event.channel_points_custom_reward_id) return;

            const messageText = event.message.text;
            const lowerMessage = messageText.toLowerCase();

            if (bot.aiManager && bot.aiManager.shouldTriggerText(messageText)) {
                const aiEnabledResult = await this.isAIEnabled(bot);

                if (!aiEnabledResult) {
                    logger.debug('ChatMessageHandler', 'AI request ignored - AI is disabled', {
                        userId: context.userId,
                        userName: context.username
                    });
                    await bot.analyticsManager.trackChatMessage(
                        context.username,
                        context.userId,
                        bot.currentStreamId,
                        messageText,
                        'message',
                        userContext
                    );
                    return;
                }

                const prompt = bot.aiManager.extractPrompt(messageText, 'text');
                if (prompt) {
                    logger.debug('ChatMessageHandler', 'Processing AI text request', {
                        userId: context.userId,
                        userName: context.username,
                        prompt: prompt
                    });

                    const result = await bot.aiManager.handleTextRequest(prompt, context.userId, bot.currentStreamId, userContext);

                    if (result.success) {
                        logger.info('ChatMessageHandler', 'AI text request processed successfully', {
                            userId: context.userId,
                            userName: context.username
                        });
                        await bot.sendMessage(bot.channelName, `@${context.username} ${result.response}`);
                    } else {
                        logger.warn('ChatMessageHandler', 'AI text request failed', {
                            userId: context.userId,
                            userName: context.username,
                            message: result.message
                        });
                        await bot.sendMessage(bot.channelName, `@${context.username} ${result.message}`);
                    }

                    await bot.analyticsManager.trackChatMessage(
                        context.username,
                        context.userId,
                        bot.currentStreamId,
                        messageText,
                        'message',
                        userContext
                    );
                    return;
                }
            }

            const emoteResponse = await this.emoteManager.getEmoteResponse(lowerMessage);
            if (emoteResponse) {
                logger.info('ChatMessageHandler', 'Emote response triggered', {
                    userId: context.userId,
                    userName: context.username,
                    emote: lowerMessage
                });
                await bot.analyticsManager.trackChatMessage(
                    context.username,
                    context.userId,
                    bot.currentStreamId,
                    messageText,
                    'message',
                    userContext
                );
                await bot.sendMessage(bot.channelName, emoteResponse);
                return;
            }

            if (lowerMessage.startsWith('!')) {
                logger.debug('ChatMessageHandler', 'Processing command', {
                    userId: context.userId,
                    userName: context.username,
                    command: messageText
                });
                await bot.analyticsManager.trackChatMessage(
                    context.username,
                    context.userId,
                    bot.currentStreamId,
                    messageText,
                    'command',
                    userContext
                );
                await this.commandManager.handleCommand(bot, bot.channelName, context, event.message.text);
            } else {
                logger.debug('ChatMessageHandler', 'Regular message received', {
                    userId: context.userId,
                    userName: context.username
                });
                await bot.analyticsManager.trackChatMessage(
                    context.username,
                    context.userId,
                    bot.currentStreamId,
                    messageText,
                    'message',
                    userContext
                );
            }
        } catch (error) {
            logger.error('ChatMessageHandler', 'Error handling chat message', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async isAIEnabled(bot) {
        try {
            const cacheManager = this.getCacheManager();

            if (cacheManager) {
                const cached = await cacheManager.get(AI_ENABLED_CACHE_KEY);
                if (cached !== null) {
                    logger.debug('ChatMessageHandler', 'AI enabled status from cache', {
                        aiEnabled: cached === 'true'
                    });
                    return cached === 'true';
                }
            }

            const sql = 'SELECT token_value FROM tokens WHERE token_key = ?';
            const result = await bot.analyticsManager.dbManager.query(sql, ['aiEnabled']);

            let aiEnabled = true;
            if (result.length > 0) {
                aiEnabled = result[0].token_value === 'true';
            }

            if (cacheManager) {
                await cacheManager.set(
                    AI_ENABLED_CACHE_KEY,
                    aiEnabled ? 'true' : 'false',
                    config.cache.aiEnabledTTL
                );
            }

            return aiEnabled;
        } catch (error) {
            logger.error('ChatMessageHandler', 'Error checking AI enabled status', {
                error: error.message,
                stack: error.stack
            });
            return true;
        }
    }
}

module.exports = ChatMessageHandler;
