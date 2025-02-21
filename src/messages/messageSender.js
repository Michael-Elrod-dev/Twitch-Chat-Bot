// src/messages/messageSender.js
const config = require('../config/config');

class MessageSender {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
    }

    async sendMessage(channel, message) {
        try {
            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.botId) {
                console.error('Missing required IDs -', {
                    channelId: this.tokenManager.tokens.channelId,
                    botId: this.tokenManager.tokens.botId
                });
                return;
            }
    
            try {
                await this.tokenManager.validateToken('bot');
            } catch (error) {
                console.error('❌ Error validating bot token:', error);
                throw error;
            }
    
            const response = await fetch(`${config.twitchApiEndpoint}/chat/messages`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.botAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_id: this.tokenManager.tokens.channelId,
                    sender_id: this.tokenManager.tokens.botId,
                    message: message
                })
            });
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Failed to send chat message: ${JSON.stringify(errorData)}`);
            }
        } catch (error) {
            console.error('❌ Error sending chat message:', error);
            throw error;
        }
    }
}

module.exports = MessageSender;