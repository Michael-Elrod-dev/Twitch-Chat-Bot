// src/bot.js
const tmi = require('tmi.js');
const TokenManager = require('./tokenManager');
const CommandManager = require('./commandManager');
const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { RefreshingAuthProvider } = require('@twurple/auth');

class Bot {
    async init() {
        this.tokenManager = new TokenManager();
        this.client = new tmi.client(this.tokenManager.getConfig());
        
        const clientId = this.tokenManager.tokens.clientId.trim().replace(/\r?\n|\r/g, '');
        const clientSecret = this.tokenManager.tokens.clientSecret.trim().replace(/\r?\n|\r/g, '');
        const channelId = this.tokenManager.tokens.channelId?.trim();
        
        // Create the auth provider with refresh callback
        const authProvider = new RefreshingAuthProvider({
            clientId,
            clientSecret,
            onRefresh: async (userId, newTokenData) => {
                console.log(`* Token refreshed for user ${userId}`);
                // Update the appropriate token in tokens.json based on userId
                if (userId === channelId) {
                    this.tokenManager.tokens.broadcasterAccessToken = newTokenData.accessToken;
                    this.tokenManager.tokens.broadcasterRefreshToken = newTokenData.refreshToken;
                } else {
                    this.tokenManager.tokens.botAccessToken = newTokenData.accessToken;
                    this.tokenManager.tokens.botRefreshToken = newTokenData.refreshToken;
                }
                // Save updated tokens
                await this.tokenManager.saveTokens();
            }
        });
    
        // Add broadcaster token for EventSub
        await authProvider.addUserForToken({
            accessToken: this.tokenManager.tokens.broadcasterAccessToken,
            refreshToken: this.tokenManager.tokens.broadcasterRefreshToken,
            scope: ['channel:read:redemptions', 'channel:manage:redemptions'],
            userId: channelId
        });
    
        // Add bot token for chat
        await authProvider.addUserForToken({
            accessToken: this.tokenManager.tokens.botAccessToken,
            refreshToken: this.tokenManager.tokens.botRefreshToken,
            scope: ['chat:edit', 'chat:read']
        });
        
        this.userApiClient = new ApiClient({ authProvider });
        
        this.listener = new EventSubWsListener({ 
            apiClient: this.userApiClient
        });
        
        this.client.on('message', this.onMessageHandler.bind(this));
        this.client.on('connected', this.onConnectedHandler.bind(this));
        this.client.on('disconnected', this.onDisconnectedHandler.bind(this));
    }

   constructor() {
       this.init().catch(console.error);
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

           // Subscribe to channel point redemptions using broadcaster's token context
           await this.listener.onChannelRedemptionAdd(channelId, (event) => {
               console.log('* Channel Point Redemption Detected:');
               console.log(`  User: ${event.userDisplayName}`);
               console.log(`  Reward: ${event.rewardTitle}`);
               console.log(`  Input: ${event.input || 'No input provided'}`);
           });
           
           console.log('* Successfully set up channel point redemption listener');
           
       } catch (error) {
           console.error('Error setting up channel point redemptions:', error.message);
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

const bot = new Bot();
bot.initialize();

module.exports = bot.client;