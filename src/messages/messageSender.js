// src/messages/messageSender.js

const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

class MessageSender {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
    }

    async sendMessage(channel, message) {
        try {
            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.botId) {
                logger.error('MessageSender', 'Missing required IDs', {
                    channelId: this.tokenManager.tokens.channelId,
                    botId: this.tokenManager.tokens.botId
                });
                return;
            }

            logger.debug('MessageSender', 'Preparing to send message', {
                channel: channel,
                messageLength: message.length
            });

            try {
                await this.tokenManager.validateToken('bot');
            } catch (error) {
                logger.error('MessageSender', 'Error validating bot token', {
                    error: error.message,
                    stack: error.stack
                });
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
                logger.error('MessageSender', 'Failed to send chat message', {
                    statusCode: response.status,
                    errorData: JSON.stringify(errorData)
                });
                throw new Error(`Failed to send chat message: ${JSON.stringify(errorData)}`);
            }

            logger.info('MessageSender', 'Message sent successfully', {
                channel: channel,
                messageLength: message.length
            });
        } catch (error) {
            logger.error('MessageSender', 'Error sending chat message', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
}

module.exports = MessageSender;
