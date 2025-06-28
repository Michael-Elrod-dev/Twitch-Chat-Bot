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

        // Logging Configuration
        this.logging = {
            level: 2, // 0=ERROR, 1=USER, 2=SYSTEM
            maxLogFiles: 20 // Keep last 20 days of logs
        };

        // Discord Webhook
        this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

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
                model: 'claude-4-sonnet-20250514',
                maxTokens: 200,
                temperature: 0.7,
                maxCharacters: 400,
                apiVersion: '2023-06-01',
            },
            openai: {
                model: 'dall-e-3',
                temperature: 0.7,
                imageSize: '1024x1024',
                imageQuality: 'standard'
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
            },
            openai_image: {
                streamLimits: {
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
                imagePromptPrefix: "",
                styleInstructions: "(cartoon style unless otherwise mentioned in prompt)",
                safetyGuidelines: ""
            }
        };

        // Trigger Settings
        this.aiTriggers = {
            text: ['@almosthadai', 'almosthadai'],
            image: ['!image']
        };

        // Error Responses
        this.errorMessages = {
            ai: {
                unavailable: "Sorry, I'm having trouble responding right now.",
                imageUnavailable: "Sorry, I can't generate images right now.",
                rateLimited: "Please wait before using AI again.",
                globalLimit: "AI is temporarily busy. Please try again in a moment."
            }
        };
    }
}

module.exports = new Config();