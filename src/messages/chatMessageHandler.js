// src/messages/chatMessageHandler.js

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
    
            // Extract badge information
            const isBroadcaster = event.badges?.some(badge => badge.set_id === "broadcaster") || false;
            const isMod = event.badges?.some(badge => badge.set_id === "moderator") || false;
            const isSubscriber = event.badges?.some(badge => badge.set_id === "subscriber") || false;
            
            const userContext = {
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

            // Check for IMAGE requests FIRST
            if (bot.aiManager && bot.aiManager.shouldTriggerImage(messageText)) {
                const prompt = bot.aiManager.extractPrompt(messageText, 'image');
                if (prompt) {
                    const result = await bot.aiManager.handleImageRequest(prompt, context.userId, userContext);
                    
                    if (result.success) {
                        await bot.sendMessage(bot.channelName, `@${context.username} ${result.response}`);
                    } else {
                        await bot.sendMessage(bot.channelName, `@${context.username} ${result.message}`);
                    }
                    
                    // Track analytics
                    await bot.analyticsManager.trackChatMessage(
                        context.username, 
                        context.userId, 
                        bot.currentStreamId, 
                        messageText, 
                        'command',
                        userContext
                    );
                    return;
                }
            }

            // Check for TEXT AI requests
            if (bot.aiManager && bot.aiManager.shouldTriggerText(messageText)) {
                const prompt = bot.aiManager.extractPrompt(messageText, 'text');
                if (prompt) {
                    const result = await bot.aiManager.handleTextRequest(prompt, context.userId, userContext);
                    
                    if (result.success) {
                        await bot.sendMessage(bot.channelName, `@${context.username} ${result.response}`);
                    } else {
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
            console.error('❌ Error handling chat message:', error);
        }
    }
}

module.exports = ChatMessageHandler;