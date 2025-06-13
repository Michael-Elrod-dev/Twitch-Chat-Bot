// src/bot.js
const config = require('./config/config');
const AIManager = require('./ai/aiManager');
const TwitchAPI = require('./tokens/twitchAPI');
const DbManager = require('./database/dbManager')
const EmoteManager = require('./emotes/emoteManager');
const TokenManager = require('./tokens/tokenManager');
const CommandManager = require('./commands/commandManager');
const AnalyticsManager = require('./analytics/analyticsManager');
const QuoteManager = require('./redemptions/quotes/quoteManager');
const SpotifyManager = require('./redemptions/songs/spotifyManager');
const RedemptionManager = require('./redemptions/redemptionManager');

const MessageSender = require('./messages/messageSender');
const WebSocketManager = require('./websocket/webSocketManager');
const RedemptionHandler = require('./messages/redemptionHandler');
const ChatMessageHandler = require('./messages/chatMessageHandler');
const SubscriptionManager = require('./websocket/subscriptionManager');

const handleQuote = require('./redemptions/quotes/handleQuote');
const handleSongRequest = require('./redemptions/songs/songRequest');
const specialCommandHandlers = require('./commands/specialCommandHandlers');

class Bot {
    constructor() {
        this.currentStreamId = null;
        this.isStreaming = false;
        this.channelName = config.channelName;
    }

    async init() {
        try {
            this.dbManager = new DbManager();
            await this.dbManager.connect();

            this.tokenManager = new TokenManager();
            await this.tokenManager.init(this.dbManager);
            
            this.twitchAPI = new TwitchAPI(this.tokenManager);

            this.aiManager = new AIManager();
            await this.aiManager.init(
                this.dbManager, 
                this.tokenManager.tokens.claudeApiKey,
                this.tokenManager.tokens.openaiApiKey
            );
            
            // Check if stream is live
            const streamInfo = await this.twitchAPI.getStreamByUserName(this.channelName);
            // if (streamInfo) {
            //     console.log('🔴 Stream is live! Starting full bot functionality...');
                
            // } else {
            //     console.log('⚫ Stream is offline. Bot will wait for stream to go live...');
            //     await this.startMinimalOperation();
            // }
            await this.startFullOperation();

        } catch (error) {
            console.error('❌ Failed to initialize bot:', error);
            throw error;
        }
    }

    async startMinimalOperation() {
        // Only start WebSocket connection to listen for stream events
        this.webSocketManager = new WebSocketManager(
            this.tokenManager,
            null,
            null,
            this.handleStreamOffline.bind(this),
            this.handleStreamOnline.bind(this)
        );
        
        this.webSocketManager.onSessionReady = async (sessionId) => {
            this.subscriptionManager = new SubscriptionManager(this.tokenManager, sessionId);
            await this.subscriptionManager.subscribeToStreamOnline();
            await this.subscriptionManager.subscribeToStreamOffline();
        };
        
        await this.webSocketManager.connect();
        
        // Start token refresh interval even in minimal mode
        setInterval(async () => {
            try {
                await this.tokenManager.checkAndRefreshTokens();
            } catch (error) {
                console.error('❌ Error in periodic token refresh:', error);
            }
        }, config.tokenRefreshInterval);
    }

    async startFullOperation() {
        if (this.isStreaming) return; // Already running
        
        console.log('🚀 Starting full bot operation...');
        
        try {
            this.isStreaming = true;

            // Initialize all the analytics, commands, etc.
            this.analyticsManager = new AnalyticsManager();
            await this.analyticsManager.init(this.dbManager);
            this.viewerManager = this.analyticsManager.viewerTracker;
            
            this.emoteManager = new EmoteManager();
            await this.emoteManager.init(this.dbManager);

            this.quoteManager = new QuoteManager();
            await this.quoteManager.init(this.dbManager);
    
            this.currentStreamId = Date.now().toString();
            this.tokenManager = new TokenManager();
            await this.tokenManager.init(this.dbManager);
            
            this.twitchAPI = new TwitchAPI(this.tokenManager);
            const streamInfo = await this.twitchAPI.getStreamByUserName(this.channelName);
            let streamTitle = null;
            let streamCategory = null;

            if (streamInfo) {
                const channelInfo = await this.twitchAPI.getChannelInfo(this.tokenManager.tokens.channelId);
                if (channelInfo) {
                    streamTitle = channelInfo.title;
                    streamCategory = channelInfo.game_name;
                }
            }
            await this.analyticsManager.trackStreamStart(
                this.currentStreamId,
                streamTitle,
                streamCategory
            );
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.init(this.dbManager);
            await this.spotifyManager.authenticate();
                
            const handlers = specialCommandHandlers({
                quoteManager: this.quoteManager,
                spotifyManager: this.spotifyManager,
                viewerManager: this.viewerManager
            });
            this.commandManager = new CommandManager(handlers);
            await this.commandManager.init(this.dbManager);
    
            this.messageSender = new MessageSender(this.tokenManager);
            
            this.chatMessageHandler = new ChatMessageHandler(
                this.viewerManager,
                this.commandManager,
                this.emoteManager,
                this.aiManager
            );
            
            this.redemptionManager = new RedemptionManager(this, this.spotifyManager);
            this.redemptionHandler = new RedemptionHandler(
                this.viewerManager,
                this.redemptionManager
            );
            this.redemptionManager.registerHandler("Song Request", handleSongRequest);
            this.redemptionManager.registerHandler("Skip Song Queue", handleSongRequest);
            this.redemptionManager.registerHandler("Add a quote", handleQuote);
    
            this.subscriptionManager = new SubscriptionManager(
                this.tokenManager,
                null
            );
    
            this.webSocketManager = new WebSocketManager(
                this.tokenManager,
                this.handleChatMessage.bind(this),
                this.handleRedemption.bind(this),
                this.handleStreamOffline.bind(this)
            );
            this.webSocketManager.onSessionReady = async (sessionId) => {
                this.subscriptionManager.setSessionId(sessionId);
                await this.subscriptionManager.subscribeToChatEvents();
                await this.subscriptionManager.subscribeToChannelPoints();
                await this.subscriptionManager.subscribeToStreamOffline();
            };
            await this.webSocketManager.connect();
            this.startViewerTracking();
    
            setInterval(async () => {
                try {
                    await this.tokenManager.checkAndRefreshTokens();
                } catch (error) {
                    console.error('❌ Error in periodic token refresh:', error);
                }
            }, config.tokenRefreshInterval);
        } catch (error) {
            console.error('❌ Error during full operation startup:', error);
            this.isStreaming = false; // Reset flag on failure
            this.isStreaming = true;
            throw error;
        }
    }

    startViewerTracking() {
        setInterval(async () => {
            try {
                if (!this.currentStreamId) return;
                
                const streamData = await this.twitchAPI.getStreamByUserName(this.channelName);
                if (streamData && streamData.viewer_count) {
                    const updateSql = `
                        UPDATE streams
                        SET peak_viewers = GREATEST(peak_viewers, ?)
                        WHERE stream_id = ?
                    `;
                    await this.dbManager.query(updateSql, [streamData.viewer_count, this.currentStreamId]);
                }
            } catch (error) {
                console.error('❌ Error tracking viewer count:', error);
            }
        }, config.viewerTrackingInterval);
    }
    
    async handleChatMessage(payload) {
        if (!this.isStreaming) return;
        await this.chatMessageHandler.handleChatMessage(payload, this);
    }

    async handleRedemption(payload) {
        if (!this.isStreaming) return;
        await this.redemptionHandler.handleRedemption(payload, this);
    }

    async handleStreamOffline() {
        console.log('⚫ Stream went offline. Stopping full bot functionality...');
        
        try {
            // Send offline message to chat BEFORE disabling functionality
            if (this.isStreaming && this.messageSender) {
                try {
                    await this.sendMessage(this.channelName, '🤖 Bot going offline. See you next stream!');
                } catch (messageError) {
                    console.error('❌ Error sending offline message to chat:', messageError);
                }
            }
            
            if (this.currentStreamId && this.analyticsManager) {
                await this.analyticsManager.trackStreamEnd(this.currentStreamId);
                this.currentStreamId = null;
            }
            
            // Clear viewer tracking
            if (this.viewerTrackingInterval) {
                clearInterval(this.viewerTrackingInterval);
                this.viewerTrackingInterval = null;
            }
            
            // Reset to minimal operation
            this.isStreaming = false;
            this.isStreaming = true;
            
            // Update WebSocket to remove chat/redemption handlers
            if (this.webSocketManager) {
                this.webSocketManager.chatHandler = null;
                this.webSocketManager.redemptionHandler = null;
            }
            
            console.log('🎯 Bot successfully transitioned to minimal mode. Waiting for next stream...');
            
        } catch (error) {
            console.error('❌ Error during stream offline transition:', error);
            // Still reset the flag even if cleanup fails
            this.isStreaming = false;
            this.isStreaming = true;
        }
    }

    async sendMessage(channel, message) {
        return this.messageSender.sendMessage(channel, message);
    }

    async cleanup() {
        console.log('Starting cleanup process...');
        try {
            if (this.currentStreamId) {
                console.log('Ending stream session...');
                await this.analyticsManager.trackStreamEnd(this.currentStreamId);
            }
            
            if (this.webSocketManager) {
                console.log('Closing WebSocket connection...');
                this.webSocketManager.close();
            }
            
            if (this.dbManager) {
                console.log('Closing database connection...');
                await this.dbManager.close();
            }
            
            console.log('Cleanup complete!');
            console.log('Press any key to exit...');
            
            // Wait for keypress before exiting
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', process.exit.bind(process, 0));
        } catch (error) {
            console.error('Error during cleanup:', error);
            console.log('Press any key to exit...');
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', process.exit.bind(process, 1));
        }
    }
}

const bot = new Bot();
async function startBot() {
    try {
        await bot.init();
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}
startBot();

module.exports = bot;