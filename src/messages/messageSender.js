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

            // No pre-flight validation: the refresh cycle keeps the token current,
            // and validating here cost a Twitch API call plus a DB write on every
            // single chat line. A rejected send is handled below instead.
            let response = await this.postMessage(message);

            if (response.status === 401) {
                logger.warn('MessageSender', 'Bot token rejected, refreshing once and retrying');

                await this.tokenManager.refreshToken('bot');
                response = await this.postMessage(message);
            }

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

    postMessage(message) {
        return fetch(`${config.twitchApiEndpoint}/chat/messages`, {
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
    }
}

module.exports = MessageSender;
