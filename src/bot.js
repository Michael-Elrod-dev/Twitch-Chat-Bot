// src/bot.js
const tmi = require('tmi.js');
const TokenManager = require('./tokens/tokenManager');
const SpotifyManager = require('./redemptions/songs/spotifyManager');
const CommandManager = require('./commands/commandManager');
const RedemptionManager = require('./redemptions/redemptionManager');
const ChatManager = require('./chats/chatManager');
const handleSongRequest = require('./redemptions/songs/songRequest');
const handleQuote = require('./redemptions/quotes/handleQuote');

const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { RefreshingAuthProvider } = require('@twurple/auth');

class Bot {
    constructor() {
        // Don't call init in constructor, chain it with initialize
    }

    async init() {
        try {
            this.tokenManager = new TokenManager();
            // await this.tokenManager.checkAndRefreshTokens();
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.authenticate();
            global.spotifyManager = this.spotifyManager;

            this.chatManager = new ChatManager();
            global.chatManager = this.chatManager;
            
            this.client = new tmi.client(this.tokenManager.getConfig());
            this.client.tokenManager = this.tokenManager;

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
            
            this.client.tokenManager.apiClient = this.userApiClient;

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
            await this.tokenManager.validateToken('broadcaster');
            const response = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: {
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`
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
            
        // Add check for redemption messages
        if (context['custom-reward-id']) {
            return;
        }
        
        const message = msg.trim();
        
        if (message.startsWith('!')) {
            await this.chatManager.incrementMessageCount(context.username, 'command');
            await CommandManager.handleCommand(this.client, target, context, message);
        } else {
            await this.chatManager.incrementMessageCount(context.username, 'message');
        }
    }

    onConnectedHandler(addr, port) {
        console.log(`* Connected to ${addr}:${port}`);
    }

    async onDisconnectedHandler(reason) {
        console.log(`* Bot disconnected: ${reason}`);
        try {
            await this.tokenManager.validateToken('bot');
            this.client.connect();
        } catch (error) {
            console.error('Failed to refresh token:', error);
        }
    }

    async setupChannelPointRedemptions() {
        try {
            console.log('* Setting up channel point redemption listener...');
     
            await this.tokenManager.validateToken('broadcaster');
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
            this.redemptionManager.registerHandler("Skip Song Queue", handleSongRequest);
            this.redemptionManager.registerHandler("Add a quote", handleQuote);
     
            await this.listener.onChannelRedemptionAdd(channelId, async (event) => {
                // Track all redemptions
                await this.chatManager.incrementMessageCount(event.userDisplayName, 'redemption');
    
                console.log('* Raw redemption event received:', {
                    timestamp: new Date().toISOString(),
                    title: event.rewardTitle,
                    user: event.userDisplayName,
                    status: event.status
                });
                
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
async function startBot() {
    try {
        await bot.init();
        await bot.initialize();
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

startBot();

module.exports = bot.client;