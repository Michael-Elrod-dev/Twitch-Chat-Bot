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
        this.tokenRefreshInterval = 300000;  // 5 minutes
        this.viewerTrackingInterval = 60000; // 1 minute
        this.spotifyInterval = 3000;         // 3 seconds
        this.emoteCacheInterval = 300000;    // 5 minutes
        this.commandCacheInterval = 300000;  // 5 minutes
        this.shutdownGracePeriod = 1800000;  // 30 minutes

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
                    mod: 15,
                    subscriber: 10,
                    everyone: 5
                }
            }
        };

        // AI-Specific Settings
        this.aiSettings = {
            claude: {
                systemPrompt: `You're a chill Twitch chat bot. Respond like a regular viewer who's knowledgeable but not trying too hard. Keep it brief (1-3 sentences max) - chat moves fast.

Be conversational and natural. You can be sarcastic or have light banter when it fits, but don't force it. Match the vibe of the chat. Don't sound like an AI assistant - no "I'd be happy to help!" or overly formal language. Just talk like a normal person would in Twitch chat.

If someone's asking something dumb or obvious, you can gently roast them. If it's a genuine question, give a straight answer. Read the room based on the chat history.

Keep responses under ${this.aiModels.claude.maxCharacters} characters.`,
                chatHistoryLimit: 50  // Number of recent chat messages to include as context
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
