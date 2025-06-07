// src/bot.js
const config = require('./config/config');
const TwitchAPI = require('./tokens/twitchAPI');
const DbManager = require('./database/dbManager')
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

            this.analyticsManager = new AnalyticsManager();
            await this.analyticsManager.init();
            this.viewerManager = this.analyticsManager.viewerTracker;
            
            this.quoteManager = new QuoteManager();
            await this.quoteManager.init(this.dbManager);
    
            this.currentStreamId = Date.now().toString();
            this.tokenManager = new TokenManager(this.dbManager);
            await this.tokenManager.checkAndRefreshTokens();
            
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
            await this.spotifyManager.authenticate();
                
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
            this.startViewerTracking();
    
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