// src/config/config.js
const path = require('path');

class Config {
    constructor() {
        // Channel settings
        this.channelName = 'aimosthadme';

        // Paths
        this.dataPath = path.join(__dirname, '..', 'data');
        this.tokensPath = path.join(this.dataPath, 'tokens.json');

        // WebSocket
        this.wsEndpoint = 'wss://eventsub.wss.twitch.tv/ws';
        this.wsReconnectDelay = 5000; // 5 seconds

        // API Endpoints
        this.twitchApiEndpoint = 'https://api.twitch.tv/helix';
        this.spotifyApiEndpoint = 'https://api.spotify.com/v1';

        // Intervals
        this.tokenRefreshInterval = 30 * 60 * 1000; // 30 minutes
        this.spotifyInterval = 3000; // 3 seconds
    }
}

module.exports = new Config();