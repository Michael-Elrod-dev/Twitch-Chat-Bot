// src/config/config.js
require('dotenv').config();
const path = require('path');

class Config {
    constructor() {
        // Channel settings
        this.channelName = 'aimosthadme';

        // Paths
        this.dataPath = path.join(__dirname, '..', 'data');

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

        // Intervals
        this.tokenRefreshInterval = 300000; // 5 minutes
        this.viewerTrackingInterval = 60000 // 1 minute
        this.steamingInterval = 10000; // 10 seconds
        this.spotifyInterval = 3000; // 3 seconds
        this.emoteCacheInterval = 300000; // 5 minutes
        this.commandCacheInterval = 300000; // 5 minutes
    }
}

module.exports = new Config();