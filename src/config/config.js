// src/config/config.js
const path = require('path');

class Config {
    constructor() {
        // Channel settings
        this.channelName = 'aimosthadme';

        // Paths
        this.dataPath = path.join(__dirname, '..', 'data');
        this.dbConfigPath = path.join(this.dataPath, 'db.json');
        this.tokensPath = path.join(this.dataPath, 'tokens.json');

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
    }
}

module.exports = new Config();