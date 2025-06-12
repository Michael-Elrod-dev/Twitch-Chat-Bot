// src/config/config.js
require('dotenv').config();
const path = require('path');

class Config {
    constructor() {
        // Channel settings
        this.channelName = 'aimosthadme';

        // Database
        this.database = {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        };

        // WebSocket
        this.wsEndpoint = 'wss://eventsub.wss.twitch.tv/ws';
        this.wsReconnectDelay = 5000; // 5 seconds

        // API Endpoints
        this.twitchAuthEndpoint = 'https://id.twitch.tv/oauth2';
        this.twitchApiEndpoint = 'https://api.twitch.tv/helix';
        this.spotifyApiEndpoint = 'https://api.spotify.com/v1';
        this.claudeApiEndpoint = 'https://api.anthropic.com/v1';
        this.openaiApiEndpoint = 'https://api.openai.com/v1';

        // Intervals
        this.tokenRefreshInterval = 300000; // 5 minutes
        this.viewerTrackingInterval = 60000; // 1 minute
        this.steamingInterval = 10000; // 10 seconds
        this.spotifyInterval = 3000; // 3 seconds
        this.emoteCacheInterval = 300000; // 5 minutes
        this.commandCacheInterval = 300000; // 5 minutes

        // AI Model Settings
        this.aiModels = {
            claude: {
                apiEndpoint: this.claudeApiEndpoint,
                model: 'claude-4-sonnet-20250514',
                maxTokens: 200,
                temperature: 0.7,
                maxCharacters: 400
            },
            openai: {
                apiEndpoint: this.openaiApiEndpoint,
                model: 'gpt-4',
                maxTokens: 1000,
                temperature: 0.7,
                imageSize: '1024x1024',
                imageQuality: 'standard'
            }
        };

        // Rate Limits
        this.rateLimits = {
            claude: {
                globalMaxPerMinute: 20,
                cooldowns: {
                    broadcaster: 0,        // No cooldown
                    mod: 10000,           // 10 seconds
                    subscriber: 20000,    // 20 seconds
                    everyone: 45000       // 45 seconds
                },
                dailyLimits: {
                    broadcaster: 999999,  // Unlimited
                    mod: 100,            // 100 per day
                    subscriber: 50,      // 50 per day
                    everyone: 20         // 20 per day
                }
            },
            openai_image: {
                globalMaxPerMinute: 5,   // Images are expensive/slow
                cooldowns: {
                    broadcaster: 0,
                    mod: 30000,          // 30 seconds
                    subscriber: 60000,   // 1 minute
                    everyone: 120000     // 2 minutes
                },
                dailyLimits: {
                    broadcaster: 999999,
                    mod: 20,
                    subscriber: 10,
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
            },
            openai: {
                imagePromptPrefix: "Create a fun, stream-appropriate image for AiMostHadMe's Twitch chat. Style should be engaging and entertaining. Prompt: ",
                styleInstructions: "cartoon style, colorful, family-friendly, gaming/streaming themed when possible",
                safetyGuidelines: "no violence, no inappropriate content, no copyrighted characters, keep it wholesome and fun"
            }
        };

        // Trigger Settings
        this.aiTriggers = {
            text: ['@almosthadai', 'almosthadai'],
            image: ['!image']
        };
    }
}

module.exports = new Config();