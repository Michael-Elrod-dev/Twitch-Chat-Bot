// src/bot.js
const WebSocket = require('ws');
const TokenManager = require('./tokens/tokenManager');
const SpotifyManager = require('./redemptions/songs/spotifyManager');
const CommandManager = require('./commands/commandManager');
const RedemptionManager = require('./redemptions/redemptionManager');
const ChatManager = require('./chats/chatManager');
const handleSongRequest = require('./redemptions/songs/songRequest');
const handleQuote = require('./redemptions/quotes/handleQuote');

class Bot {
    constructor() {
        this.wsConnection = null;
        this.sessionId = null;
        this.channelName = 'aimosthadme'; // Move this to config later
    }

    async init() {
        try {
            this.tokenManager = new TokenManager();
            await this.tokenManager.checkAndRefreshTokens();
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.authenticate();
            global.spotifyManager = this.spotifyManager;

            this.chatManager = new ChatManager();
            global.chatManager = this.chatManager;

            // Set up reward handlers
            this.redemptionManager = new RedemptionManager(this, this.spotifyManager);
            this.redemptionManager.registerHandler("Song Request", handleSongRequest);
            this.redemptionManager.registerHandler("Skip Song Queue", handleSongRequest);
            this.redemptionManager.registerHandler("Add a quote", handleQuote);

            // Connect to EventSub WebSocket
            await this.connectWebSocket();

        } catch (error) {
            console.error('Failed to initialize bot:', error);
            throw error;
        }
    }

    async connectWebSocket() {
        try {
            this.wsConnection = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

            this.wsConnection.on('open', () => {
                console.log('✅ Connected to EventSub WebSocket');
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
                await CommandManager.handleCommand(this, this.channelName, context, event.message.text);
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
        
            const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
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

    async chat(channel, message) {
        try {
            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.botId) {
                console.error('Missing required IDs -', {
                    channelId: this.tokenManager.tokens.channelId,
                    botId: this.tokenManager.tokens.botId
                });
                return;
            }
    
            const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.botAccessToken}`, // Use bot token instead of broadcaster
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_id: this.tokenManager.tokens.channelId,
                    sender_id: this.tokenManager.tokens.botId,  // This is required
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