// src/bot.js
const WebSocket = require('ws');
const config = require('./config/config');
const TwitchAPI = require('./tokens/twitchAPI');
const ChatManager = require('./chats/chatManager');
const TokenManager = require('./tokens/tokenManager');
const CommandManager = require('./commands/commandManager');
const QuoteManager = require('./redemptions/quotes/quoteManager');
const SpotifyManager = require('./redemptions/songs/spotifyManager');
const RedemptionManager = require('./redemptions/redemptionManager');

const handleQuote = require('./redemptions/quotes/handleQuote');
const handleSongRequest = require('./redemptions/songs/songRequest');
const specialCommandHandlers = require('./commands/specialCommandHandlers');

class Bot {
    constructor() {
        this.wsConnection = null;
        this.sessionId = null;
    }

    async init() {
        try {
            this.tokenManager = new TokenManager();
            await this.tokenManager.checkAndRefreshTokens();
            this.channelName = config.channelName;
            this.twitchAPI = new TwitchAPI(this.tokenManager);
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.authenticate();

            this.chatManager = new ChatManager();
            this.quoteManager = new QuoteManager();
            
            const handlers = specialCommandHandlers({
                quoteManager: this.quoteManager,
                spotifyManager: this.spotifyManager,
                chatManager: this.chatManager
            });
            this.commandManager = new CommandManager(handlers);

            this.redemptionManager = new RedemptionManager(this, this.spotifyManager);
            this.redemptionManager.registerHandler("Song Request", handleSongRequest);
            this.redemptionManager.registerHandler("Skip Song Queue", handleSongRequest);
            this.redemptionManager.registerHandler("Add a quote", handleQuote);

            await this.connectWebSocket();

            setInterval(async () => {
                try {
                    await this.tokenManager.checkAndRefreshTokens();
                } catch (error) {
                    console.error('Error in periodic token refresh:', error);
                }
            }, config.tokenRefreshInterval);

        } catch (error) {
            console.error('Failed to initialize bot:', error);
            throw error;
        }
    }

    async connectWebSocket() {
        try {
            this.wsConnection = new WebSocket(config.wsEndpoint);

            this.wsConnection.on('close', (code, reason) => {
                console.log(`* WebSocket closed: ${code} - ${reason}`);
                setTimeout(() => this.connectWebSocket(), config.wsReconnectDelay);
            });

            this.wsConnection.on('message', async (data) => {
                const message = JSON.parse(data);
                await this.handleWebSocketMessage(message);
            });

            this.wsConnection.on('close', (code, reason) => {
                console.log(`* WebSocket closed: ${code} - ${reason}`);
                setTimeout(() => this.connectWebSocket(), 5000);
            });

            this.wsConnection.on('error', (error) => {
                console.error('WebSocket error:', error);
            });

        } catch (error) {
            console.error('Failed to connect to WebSocket:', error);
            throw error;
        }
    }

    async handleWebSocketMessage(message) {
        try {
            if (!message.metadata) {
                console.error('Missing metadata in message:', message);
                return;
            }

            switch (message.metadata.message_type) {
                case 'session_welcome': {
                    this.sessionId = message.payload.session.id;
                    console.log('✅ Received session ID:', this.sessionId);
                    await this.subscribeToChatEvents();
                    break;
                }
                case 'notification': {
                    if (message.metadata.subscription_type === 'channel.chat.message') {
                        await this.handleChatMessage(message.payload);
                    }
                    break;
                }
                case 'session_reconnect': {
                    console.log('* Reconnect requested, reconnecting...');
                    await this.connectWebSocket();
                    break;
                }
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    }

    async handleChatMessage(payload) {
        try {
            if (!payload.event) return;
    
            const event = payload.event;
            // Skip messages from the bot itself
            if (event.chatter_user_id === this.tokenManager.tokens.botId) return;
    
            const context = {
                username: event.chatter_user_name,
                userId: event.chatter_user_id,
                mod: event.chatter_is_mod,
                badges: {
                    broadcaster: event.chatter_user_id === this.tokenManager.tokens.channelId
                },
                'custom-reward-id': event.reward_id
            };
    
            // Handle channel point redemption messages separately
            if (event.reward_id) return;
    
            if (event.message.text.startsWith('!')) {
                await this.chatManager.incrementMessageCount(context.username, 'command');
                await this.commandManager.handleCommand(this, this.channelName, context, event.message.text);
            } else {
                await this.chatManager.incrementMessageCount(context.username, 'message');
            }
        } catch (error) {
            console.error('Error handling chat message:', error);
        }
    }

    async subscribeToChatEvents() {
        try {
            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.userId) {
                throw new Error('Missing required IDs');
            }
    
            const subscription = {
                type: 'channel.chat.message',
                version: '1',
                condition: {
                    broadcaster_user_id: this.tokenManager.tokens.channelId,
                    user_id: this.tokenManager.tokens.userId
                },
                transport: {
                    method: 'websocket',
                    session_id: this.sessionId
                }
            };
        
            const response = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(subscription)
            });
    
            const responseData = await response.json();
            
            if (!response.ok) {
                throw new Error(`Failed to subscribe to chat events: ${JSON.stringify(responseData)}`);
            }
    
            console.log('✅ Subscribed to chat events');
        } catch (error) {
            console.error('Error subscribing to chat events:', error);
            throw error;
        }
    }

    async sendMessage(channel, message) {
        try {
            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.botId) {
                console.error('Missing required IDs -', {
                    channelId: this.tokenManager.tokens.channelId,
                    botId: this.tokenManager.tokens.botId
                });
                return;
            }
    
            try {
                await this.tokenManager.validateToken('bot');
            } catch (error) {
                console.error('Error validating bot token:', error);
                throw error;
            }
    
            const response = await fetch(`${config.twitchApiEndpoint}/chat/messages`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.botAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_id: this.tokenManager.tokens.channelId,
                    sender_id: this.tokenManager.tokens.botId,
                    message: message
                })
            });
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Failed to send chat message: ${JSON.stringify(errorData)}`);
            }
        } catch (error) {
            console.error('Error sending chat message:', error);
            throw error;
        }
    }
}

// Create and initialize the bot
const bot = new Bot();
async function startBot() {
    try {
        await bot.init();
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

startBot();

module.exports = bot;