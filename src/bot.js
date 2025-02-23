// src/bot.js
const config = require('./config/config');
const TwitchAPI = require('./tokens/twitchAPI');
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
            this.analyticsManager = new AnalyticsManager();
            await this.analyticsManager.init();
            this.viewerManager = this.analyticsManager.viewerTracker;
    
            // Create stream session right after analytics initialization
            this.currentStreamId = Date.now().toString(); // Simple unique ID
            await this.analyticsManager.trackStreamStart(
            this.currentStreamId,
            null, // We can fetch title later if needed
            null  // Same for category
            );
    
            this.tokenManager = new TokenManager();
            await this.tokenManager.checkAndRefreshTokens();
            
            this.twitchAPI = new TwitchAPI(this.tokenManager);
            
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.authenticate();
    
            
            this.quoteManager = new QuoteManager();
            
            const handlers = specialCommandHandlers({
                quoteManager: this.quoteManager,
                spotifyManager: this.spotifyManager,
                viewerManager: this.viewerManager
            });
            this.commandManager = new CommandManager(handlers);
    
            this.messageSender = new MessageSender(this.tokenManager);
            
            this.chatMessageHandler = new ChatMessageHandler(
                this.viewerManager,
                this.commandManager
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
    
            setInterval(async () => {
                try {
                    await this.tokenManager.checkAndRefreshTokens();
                } catch (error) {
                    console.error('❌ Error in periodic token refresh:', error);
                }
            }, config.tokenRefreshInterval);
        } catch (error) {
            console.error('❌ Failed to initialize bot:', error);
            throw error;
        }
    }

    async handleChatMessage(payload) {
        await this.chatMessageHandler.handleChatMessage(payload, this);
    }

    async handleRedemption(payload) {
        await this.redemptionHandler.handleRedemption(payload, this);
    }

    async handleStreamOffline() {
        console.log('Stream detected as ended via EventSub');
        await this.cleanup();
        process.exit(0);
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
            
            if (this.analyticsManager && this.analyticsManager.dbManager) {
                console.log('Closing database connection...');
                await this.analyticsManager.dbManager.close();
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