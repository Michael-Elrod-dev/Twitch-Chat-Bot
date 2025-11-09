// src/config/config.js

require('dotenv').config();

class Config {
    constructor() {
        // Debug Mode Detection
        this.isDebugMode = process.argv.includes('--debug');

        // Channel settings
        this.channelName = 'aimosthadme';

        // Database
        this.database = {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: this.isDebugMode ? process.env.DB_NAME + '_debug' : process.env.DB_NAME
        };

        // Logging Configuration
        this.logging = {
            level: 'info', // Levels: 'error', 'warn', 'info', 'debug'
            maxSize: '20m', // Rotate log file when it reaches this size (e.g., '20m' = 20 megabytes)
            maxFiles: 10 // Keep maximum of 10 log files before deleting oldest
        };


        // WebSocket
        this.wsEndpoint = 'wss://eventsub.wss.twitch.tv/ws';
        this.wsReconnectDelay = 5000; // 5 seconds

        // API Endpoints
        this.twitchAuthEndpoint = 'https://id.twitch.tv/oauth2';
        this.twitchApiEndpoint = 'https://api.twitch.tv/helix';
        this.claudeApiEndpoint = 'https://api.anthropic.com/v1';

        // Intervals
        this.tokenRefreshInterval = 300000; // 5 minutes
        this.viewerTrackingInterval = 60000; // 1 minute
        this.spotifyInterval = 3000; // 3 seconds
        this.emoteCacheInterval = 300000; // 5 minutes
        this.commandCacheInterval = 300000; // 5 minutes
        this.shutdownGracePeriod = 1800000; // 30 minutes - time to wait after stream offline before auto-shutdown

        // AI Model Settings
        this.aiModels = {
            claude: {
                model: 'claude-sonnet-4-5-20250929',
                maxTokens: 200,
                temperature: 0.7,
                maxCharacters: 400,
                apiVersion: '2023-06-01',
            }
        };

        // Rate Limits
        this.rateLimits = {
            claude: {
                streamLimits: {
                    broadcaster: 999999,
                    mod: 50,
                    subscriber: 50,
                    everyone: 5
                }
            }
        };

        // AI-Specific Settings
        this.aiSettings = {
            claude: {
                systemPrompt: `You are a mod and viewer in AiMostHadMe's Twitch chat. Michael (Had) is almost 30, with a small but tight
                community. The vibe is laid-back but heavily banter-focused.
He plays everything - games, react content, whatever. His cat's name is Chopper. You cannot retain information between prompts, so never
leave things open-ended. Each response should be complete and self-contained.
Users will mention you in chat for various reasons like random questions, treating you like a person, asking for random facts, etc.
Keep responses under ${this.aiModels.claude.maxCharacters} characters. Don't talk like an AI - you're just another person in chat.`
            }
        };

        // Trigger Settings
        this.aiTriggers = {
            text: ['@almosthadai', 'almosthadai']
        };

        // Error Responses
        this.errorMessages = {
            ai: {
                unavailable: 'Sorry, I\'m having trouble responding right now.',
                globalLimit: 'AI is temporarily busy. Please try again in a moment.'
            }
        };
    }
}

module.exports = new Config();
