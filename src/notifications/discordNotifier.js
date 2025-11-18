// src/notifications/discordNotifier.js

const fetch = require('node-fetch');
const logger = require('../logger/logger');

class DiscordNotifier {
    constructor(webhookUrl, twitchUrl) {
        this.webhookUrl = webhookUrl;
        this.twitchUrl = twitchUrl;
        logger.debug('DiscordNotifier', 'Discord notifier initialized', {
            webhookConfigured: !!webhookUrl,
            twitchUrl
        });
    }

    async sendStreamLiveNotification(streamTitle, streamCategory) {
        if (!this.webhookUrl) {
            logger.warn('DiscordNotifier', 'Discord webhook URL not configured, skipping notification');
            return false;
        }

        try {
            const message = this.buildNotificationMessage(streamTitle, streamCategory);

            logger.debug('DiscordNotifier', 'Sending stream live notification to Discord', {
                title: streamTitle,
                category: streamCategory,
                url: this.twitchUrl
            });

            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error('DiscordNotifier', 'Failed to send Discord notification', {
                    status: response.status,
                    statusText: response.statusText,
                    error: errorText
                });
                return false;
            }

            logger.info('DiscordNotifier', 'Successfully sent stream live notification to Discord', {
                title: streamTitle,
                category: streamCategory
            });
            return true;

        } catch (error) {
            logger.error('DiscordNotifier', 'Error sending Discord notification', {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }

    buildNotificationMessage(streamTitle, streamCategory) {
        return {
            content: '@everyone\n\n' +
                     `**${streamTitle || 'Stream is Live!'}**\n\n` +
                     `**Playing:** ${streamCategory || 'N/A'}\n\n` +
                     `${this.twitchUrl}`
        };
    }
}

module.exports = DiscordNotifier;
