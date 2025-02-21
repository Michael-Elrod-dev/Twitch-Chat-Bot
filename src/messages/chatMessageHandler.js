// src/messages/chatMessageHandler.js
const emoteResponses = require('../data/emotes.json');

class ChatMessageHandler {
    constructor(viewerManager, commandManager) {
        this.viewerManager = viewerManager;
        this.commandManager = commandManager;
    }

    async handleChatMessage(payload, bot) {
        try {
            if (!payload.event) return;
    
            const event = payload.event;
            if (event.chatter_user_id === bot.tokenManager.tokens.botId) return;
    
            const context = {
                username: event.chatter_user_name,
                userId: event.chatter_user_id,
                mod: event.chatter_is_mod,
                badges: {
                    broadcaster: event.chatter_user_id === bot.tokenManager.tokens.channelId
                },
                'custom-reward-id': event.reward_id
            };
    
            if (event.reward_id) return;
    
            const messageText = event.message.text.toLowerCase();
    
            // Check for emotes
            if (emoteResponses[messageText]) {
                await bot.analyticsManager.trackChatMessage(
                    context.username, 
                    context.userId, 
                    bot.currentStreamId, 
                    messageText, 
                    'message'
                );
                await bot.sendMessage(bot.channelName, emoteResponses[messageText]);
                return;
            }
    
            // Handle regular commands
            if (messageText.startsWith('!')) {
                await bot.analyticsManager.trackChatMessage(
                    context.username, 
                    context.userId, 
                    bot.currentStreamId, 
                    messageText, 
                    'command'
                );
                await this.commandManager.handleCommand(bot, bot.channelName, context, event.message.text);
            } else {
                await bot.analyticsManager.trackChatMessage(
                    context.username, 
                    context.userId, 
                    bot.currentStreamId, 
                    messageText, 
                    'message'
                );
            }

        } catch (error) {
            console.error('❌ Error handling chat message:', error);
        }
    }
}

module.exports = ChatMessageHandler;