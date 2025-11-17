// src/messages/chatMessageHandler.js

const logger = require('../logger/logger');

class ChatMessageHandler {
    constructor(viewerManager, commandManager, emoteManager, aiManager) {
        this.viewerManager = viewerManager;
        this.commandManager = commandManager;
        this.emoteManager = emoteManager;
        this.aiManager = aiManager;
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

            // Extract badge information
            const isBroadcaster = event.badges?.some(badge => badge.set_id === 'broadcaster') || false;
            const isMod = event.badges?.some(badge => badge.set_id === 'moderator') || false;
            const isSubscriber = event.badges?.some(badge => badge.set_id === 'subscriber') || false;

            const userContext = {
                userName: event.chatter_user_name,
                isMod: isMod,
                isSubscriber: isSubscriber,
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

            // Check for TEXT AI requests
            if (bot.aiManager && bot.aiManager.shouldTriggerText(messageText)) {
                // Check if AI is enabled
                const aiEnabledResult = await this.isAIEnabled(bot);

                if (!aiEnabledResult) {
                    logger.debug('ChatMessageHandler', 'AI request ignored - AI is disabled', {
                        userId: context.userId,
                        userName: context.username
                    });
                    // Track the message but don't process AI
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

                    // Track analytics
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

            // Check for emotes using database
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

            // Handle regular commands
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
            const sql = 'SELECT token_value FROM tokens WHERE token_key = ?';
            const result = await bot.analyticsManager.dbManager.query(sql, ['aiEnabled']);

            // Default to true if not set (backwards compatibility)
            if (result.length === 0) {
                return true;
            }

            return result[0].token_value === 'true';
        } catch (error) {
            logger.error('ChatMessageHandler', 'Error checking AI enabled status', {
                error: error.message,
                stack: error.stack
            });
            // Default to true on error to avoid breaking functionality
            return true;
        }
    }
}

module.exports = ChatMessageHandler;
