// src/messages/chatMessageHandler.js

class ChatMessageHandler {
    constructor(viewerManager, commandManager, emoteManager) {
        this.viewerManager = viewerManager;
        this.commandManager = commandManager;
        this.emoteManager = emoteManager;
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
    
            const messageText = event.message.text.toLowerCase();
    
            // Check for emotes using database (this code we already added)
            const emoteResponse = await this.emoteManager.getEmoteResponse(messageText);
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
            if (messageText.startsWith('!')) {
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