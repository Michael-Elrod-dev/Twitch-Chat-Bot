// src/bot.js
const tmi = require('tmi.js');
const TokenManager = require('./utils/tokenManager');
const SpotifyManager = require('./redemptions/songRequests/spotifyManager');
const CommandManager = require('./commands/commandManager');
const RedemptionManager = require('./redemptions/songRequests/redemptionManager');
const handleSongRequest = require('./redemptions/songRequests/songRequest');

const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { RefreshingAuthProvider } = require('@twurple/auth');

class Bot {
    constructor() {
        // Don't call init in constructor, we'll chain it with initialize
    }

    async init() {
        try {
            this.tokenManager = new TokenManager();
            await this.tokenManager.checkAndRefreshTokens();
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            global.spotifyManager = this.spotifyManager;
            
            this.client = new tmi.client(this.tokenManager.getConfig());

            const clientId = this.tokenManager.tokens.clientId.trim().replace(/\r?\n|\r/g, '');
            const clientSecret = this.tokenManager.tokens.clientSecret.trim().replace(/\r?\n|\r/g, '');
            const channelId = this.tokenManager.tokens.channelId?.trim();

            if (!clientId || !clientSecret || !channelId) {
                throw new Error('Missing required token configuration');
            }

            this.authProvider = new RefreshingAuthProvider({
                clientId,
                clientSecret,
                onRefresh: async (userId, newTokenData) => {
                    try {
                        console.log(`* Token refreshed for user ${userId}`);
                        if (userId === channelId) {
                            this.tokenManager.tokens.broadcasterAccessToken = newTokenData.accessToken;
                            this.tokenManager.tokens.broadcasterRefreshToken = newTokenData.refreshToken;
                        } else {
                            this.tokenManager.tokens.botAccessToken = newTokenData.accessToken;
                            this.tokenManager.tokens.botRefreshToken = newTokenData.refreshToken;
                        }
                        await this.tokenManager.saveTokens();
                    } catch (error) {
                        console.error('Error saving refreshed tokens:', error);
                    }
                }
            });

            // Add broadcaster token for EventSub
            await this.authProvider.addUserForToken({
                accessToken: this.tokenManager.tokens.broadcasterAccessToken,
                refreshToken: this.tokenManager.tokens.broadcasterRefreshToken,
                scope: [
                    'channel:read:redemptions', 
                    'channel:manage:redemptions',
                    'channel:manage:rewards'
                ],
                userId: channelId
            });

            // Add bot token for chat
            await this.authProvider.addUserForToken({
                accessToken: this.tokenManager.tokens.botAccessToken,
                refreshToken: this.tokenManager.tokens.botRefreshToken,
                scope: ['chat:edit', 'chat:read']
            });

            this.userApiClient = new ApiClient({ authProvider: this.authProvider });

            this.listener = new EventSubWsListener({
                apiClient: this.userApiClient
            });

            this.client.on('message', this.onMessageHandler.bind(this));
            this.client.on('connected', this.onConnectedHandler.bind(this));
            this.client.on('disconnected', this.onDisconnectedHandler.bind(this));

        } catch (error) {
            console.error('Failed to initialize bot:', error);
            throw error;
        }
    }

    async checkPermissions() {
        try {
            const response = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: {
                    'Authorization': `OAuth ${this.tokenManager.tokens.broadcasterAccessToken}`
                }
            });
            const data = await response.json();

            if (!data.scopes.includes('channel:read:redemptions')) {
                console.log('* Error: Missing channel:read:redemptions scope on broadcaster token');
                console.log('* Please regenerate your broadcaster token with the required scope');
                return false;
            }
            return true;
        } catch (error) {
            console.error('Failed to check permissions:', error);
            return false;
        }
    }

    async onMessageHandler(target, context, msg, self) {
        if (self) return;
        const message = msg.trim();
        await CommandManager.handleCommand(this.client, target, context, message);
    }

    onConnectedHandler(addr, port) {
        console.log(`* Connected to ${addr}:${port}`);
    }

    async onDisconnectedHandler(reason) {
        console.log(`* Bot disconnected: ${reason}`);
        try {
            await this.tokenManager.refreshToken('bot');
            this.client.connect();
        } catch (error) {
            console.error('Failed to refresh token:', error);
        }
    }

    async setupChannelPointRedemptions() {
        try {
            console.log('* Setting up channel point redemption listener...');
    
            const channelId = this.tokenManager.tokens.channelId?.trim();
            if (!channelId) {
                throw new Error('Channel ID not found in tokens');
            }
    
            this.redemptionManager = new RedemptionManager(
                this.client, 
                this.spotifyManager,
                this.userApiClient
            );
            this.redemptionManager.registerHandler("Song Request", handleSongRequest);
    
            await this.listener.onChannelRedemptionAdd(channelId, async (event) => {
                await this.redemptionManager.handleRedemption(event);
            });
        } catch (error) {
            console.error('Error setting up channel point redemptions:', error);
            console.error('Stack:', error.stack);
        }
    }

    async initialize() {
        try {
            await this.client.connect();
    
            const hasPermissions = await this.checkPermissions();
            if (!hasPermissions) {
                console.log('* Skipping EventSub setup due to missing permissions');
                return;
            }
    
            await this.spotifyManager.authenticate();
    
            console.log('* Starting EventSub listener...');
            await this.listener.start();
            await this.setupChannelPointRedemptions();
            console.log('* Bot initialized with EventSub support');
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }
}

// Create and initialize the bot
const bot = new Bot();
bot.init()
    .then(() => bot.initialize())
    .catch(console.error);

module.exports = bot.client;