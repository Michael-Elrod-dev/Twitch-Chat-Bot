// src/config/config.js

require('dotenv').config();

class Config {
    constructor() {
        this.isDebugMode = process.argv.includes('--debug');

        this.channelName = 'aimosthadme';

        this.database = {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: this.isDebugMode ? process.env.DB_NAME + '_debug' : process.env.DB_NAME
        };

        this.aws = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            region: process.env.AWS_REGION || 'us-east-1',
            s3BucketName: process.env.AWS_S3_BUCKET_NAME
        };

        this.logging = {
            level: 'info',
            maxSize: '20m',
            maxFiles: 10
        };


        this.wsEndpoint = 'wss://eventsub.wss.twitch.tv/ws';
        this.wsReconnectDelay = 5000;

        this.twitchAuthEndpoint = 'https://id.twitch.tv/oauth2';
        this.twitchApiEndpoint = 'https://api.twitch.tv/helix';
        this.claudeApiEndpoint = 'https://api.anthropic.com/v1';

        this.discord = {
            webhookUrl: process.env.DISCORD_WEBHOOK_URL,
            notificationDelay: 30000
        };

        this.twitchChannelUrl = `https://www.twitch.tv/${this.channelName}`;

        this.tokenRefreshInterval = 300000;
        this.viewerTrackingInterval = 60000;
        this.spotifyInterval = 3000;
        this.emoteCacheInterval = 300000;
        this.commandCacheInterval = 300000;
        this.shutdownGracePeriod = 1800000;
        this.backupInterval = 3600000;

        this.aiModels = {
            claude: {
                model: 'claude-sonnet-4-5-20250929',
                maxTokens: 200,
                temperature: 0.7,
                maxCharacters: 400,
                apiVersion: '2023-06-01',
            }
        };

        this.rateLimits = {
            claude: {
                streamLimits: {
                    broadcaster: 999999,
                    mod: 15,
                    subscriber: 10,
                    everyone: 5
                }
            }
        };

        this.aiSettings = {
            claude: {
                chatHistoryLimits: {
                    regularChat: 50,
                    advice: 0,
                    roast: 0,
                }
            }
        };

        this.aiTriggers = {
            text: ['@almosthadai', 'almosthadai']
        };

        this.errorMessages = {
            ai: {
                unavailable: 'Sorry, I\'m having trouble responding right now.',
                globalLimit: 'AI is temporarily busy. Please try again in a moment.'
            }
        };
    }
}

module.exports = new Config();
