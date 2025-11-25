// src/bot.js

const config = require('./config/config');
const logger = require('./logger/logger');
const AIManager = require('./ai/aiManager');
const TwitchAPI = require('./tokens/twitchAPI');
const DbManager = require('./database/dbManager');
const EmoteManager = require('./emotes/emoteManager');
const TokenManager = require('./tokens/tokenManager');
const CommandManager = require('./commands/commandManager');
const AnalyticsManager = require('./analytics/analyticsManager');
const QuoteManager = require('./redemptions/quotes/quoteManager');
const SpotifyManager = require('./redemptions/songs/spotifyManager');
const RedemptionManager = require('./redemptions/redemptionManager');
const DbBackupManager = require('./database/dbBackupManager');
const SongToggleService = require('./services/songToggleService');
const ApiServer = require('./api/apiServer');

const MessageSender = require('./messages/messageSender');
const WebSocketManager = require('./websocket/webSocketManager');
const RedemptionHandler = require('./messages/redemptionHandler');
const ChatMessageHandler = require('./messages/chatMessageHandler');
const SubscriptionManager = require('./websocket/subscriptionManager');
const DiscordNotifier = require('./notifications/discordNotifier');

const handleQuote = require('./redemptions/quotes/handleQuote');
const handleSongRequest = require('./redemptions/songs/songRequest');

class Bot {
    constructor() {
        this.isStreaming = false;
        this.isShuttingDown = false;
        this.currentStreamId = null;
        this.channelName = config.channelName;
        this.shutdownTimer = null;
        this.tokenRefreshInterval = null;
        this.backupInterval = null;
        this.backupManager = new DbBackupManager();
        this.discordNotifier = new DiscordNotifier(
            config.discord.webhookUrl,
            config.twitchChannelUrl
        );
        logger.info('Bot', 'Bot instance created', { channelName: this.channelName });
    }

    async init() {
        try {
            logger.info('Bot', 'Starting bot initialization', { debugMode: config.isDebugMode });

            if (config.isDebugMode) {
                logger.info('Bot', '=== DEBUG MODE ENABLED ===');
                logger.info('Bot', 'Setting up debug database and logs');
                const DebugDbSetup = require('./database/debugDbSetup');
                const debugDbSetup = new DebugDbSetup();
                await debugDbSetup.setupDebugDatabase();
            }

            logger.debug('Bot', 'Initializing database connection');
            this.dbManager = new DbManager();
            await this.dbManager.connect();

            await this.cleanupOrphanedSessions();

            logger.debug('Bot', 'Initializing token manager');
            this.tokenManager = new TokenManager();
            await this.tokenManager.init(this.dbManager);

            logger.debug('Bot', 'Initializing Twitch API');
            this.twitchAPI = new TwitchAPI(this.tokenManager);

            logger.debug('Bot', 'Initializing AI manager');
            this.aiManager = new AIManager();
            await this.aiManager.init(
                this.dbManager,
                this.tokenManager.tokens.claudeApiKey
            );

            if (config.isDebugMode) {
                logger.info('Bot', 'Debug mode - forcing full operation (stream status ignored)');
                await this.startFullOperation();
            } else {
                logger.info('Bot', 'Checking stream status');
                const streamInfo = await this.twitchAPI.getStreamByUserName(this.channelName);
                if (streamInfo) {
                    logger.info('Bot', 'Stream is live! Starting full bot functionality', { streamId: streamInfo.id });
                    await this.startFullOperation();
                } else {
                    logger.info('Bot', 'Stream is offline. Bot will wait for stream to go live');
                    await this.startMinimalOperation();
                }
            }

            logger.info('Bot', 'Bot initialization complete');

        } catch (error) {
            logger.error('Bot', 'Failed to initialize bot', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async startMinimalOperation() {
        logger.info('Bot', 'Starting minimal operation mode');

        this.webSocketManager = new WebSocketManager(
            this.tokenManager,
            null,
            null,
            this.handleStreamOffline.bind(this),
            this.handleStreamOnline.bind(this),
            this.handleFollow.bind(this)
        );

        this.webSocketManager.onSessionReady = async (sessionId) => {
            logger.debug('Bot', 'WebSocket session ready in minimal mode', { sessionId });
            this.subscriptionManager = new SubscriptionManager(this.tokenManager, sessionId);
            await this.subscriptionManager.subscribeToStreamOnline();
            await this.subscriptionManager.subscribeToStreamOffline();
            await this.subscriptionManager.subscribeToChannelFollow();
        };

        await this.webSocketManager.connect();

        logger.debug('Bot', 'Starting token refresh interval');
        this.tokenRefreshInterval = setInterval(async () => {
            try {
                if (this.isShuttingDown) return;
                await this.tokenManager.checkAndRefreshTokens();
            } catch (error) {
                logger.error('Bot', 'Error in periodic token refresh', { error: error.message });
            }
        }, config.tokenRefreshInterval);

        logger.info('Bot', 'Minimal operation mode active - waiting for stream to go live');
    }

    async startFullOperation() {
        if (this.isStreaming) {
            logger.debug('Bot', 'Full operation already running, skipping start');
            return;
        }

        if (this.isShuttingDown) {
            logger.warn('Bot', 'Cannot start full operation - bot is shutting down');
            return;
        }

        logger.info('Bot', 'Starting full bot operation');

        try {
            this.isStreaming = true;

            if (this.shutdownTimer) {
                logger.info('Bot', 'Stream came back online! Cancelling auto-shutdown timer');
                clearTimeout(this.shutdownTimer);
                this.shutdownTimer = null;
            }

            logger.debug('Bot', 'Initializing analytics manager');
            this.analyticsManager = new AnalyticsManager();
            await this.analyticsManager.init(this.dbManager);
            this.viewerManager = this.analyticsManager.viewerTracker;

            logger.debug('Bot', 'Initializing emote manager');
            this.emoteManager = new EmoteManager();
            await this.emoteManager.init(this.dbManager);

            logger.debug('Bot', 'Initializing quote manager');
            this.quoteManager = new QuoteManager();
            await this.quoteManager.init(this.dbManager);

            this.currentStreamId = Date.now().toString();
            logger.info('Bot', 'Created new stream session', { streamId: this.currentStreamId });

            logger.debug('Bot', 'Fetching stream information for analytics');
            const streamInfo = await this.twitchAPI.getStreamByUserName(this.channelName);
            let streamTitle = null;
            let streamCategory = null;

            if (streamInfo) {
                const channelInfo = await this.twitchAPI.getChannelInfo(this.tokenManager.tokens.channelId);
                if (channelInfo) {
                    streamTitle = channelInfo.title;
                    streamCategory = channelInfo.game_name;
                    logger.debug('Bot', 'Retrieved stream metadata', { title: streamTitle, category: streamCategory });
                }
            }

            await this.analyticsManager.trackStreamStart(
                this.currentStreamId,
                streamTitle,
                streamCategory
            );

            logger.debug('Bot', 'Initializing Spotify manager');
            this.spotifyManager = new SpotifyManager(this.tokenManager);
            await this.spotifyManager.init(this.dbManager);
            await this.spotifyManager.authenticate();

            logger.debug('Bot', 'Initializing song toggle service');
            this.songToggleService = new SongToggleService(this.twitchAPI);

            logger.debug('Bot', 'Initializing command manager');
            this.commandManager = CommandManager.createWithDependencies({
                quoteManager: this.quoteManager,
                spotifyManager: this.spotifyManager,
                viewerManager: this.viewerManager,
                songToggleService: this.songToggleService
            });
            await this.commandManager.init(this.dbManager);

            logger.debug('Bot', 'Initializing message sender');
            this.messageSender = new MessageSender(this.tokenManager);

            if (config.apiEnabled) {
                logger.debug('Bot', 'Initializing API server');
                this.apiServer = new ApiServer(config, this.songToggleService, this.messageSender);
                try {
                    await this.apiServer.start();
                } catch (error) {
                    logger.error('Bot', 'Failed to start API server', { error: error.message });
                }
            }

            logger.debug('Bot', 'Initializing chat message handler');
            this.chatMessageHandler = new ChatMessageHandler(
                this.viewerManager,
                this.commandManager,
                this.emoteManager,
                this.aiManager
            );

            logger.debug('Bot', 'Initializing redemption handlers');
            this.redemptionManager = new RedemptionManager(this, this.spotifyManager);
            this.redemptionHandler = new RedemptionHandler(
                this.viewerManager,
                this.redemptionManager
            );
            this.redemptionManager.registerHandler('Song Request', handleSongRequest);
            this.redemptionManager.registerHandler('Skip Song Queue', handleSongRequest);
            this.redemptionManager.registerHandler('Add a quote', handleQuote);

            if (this.webSocketManager) {
                logger.debug('Bot', 'Reusing existing WebSocket connection');
                this.webSocketManager.chatHandler = this.handleChatMessage.bind(this);
                this.webSocketManager.redemptionHandler = this.handleRedemption.bind(this);
                this.webSocketManager.followHandler = this.handleFollow.bind(this);

                if (this.subscriptionManager) {
                    await this.subscriptionManager.subscribeToChatEvents();
                    await this.subscriptionManager.subscribeToChannelPoints();
                }
            } else {
                logger.info('Bot', 'Creating new WebSocket connection');

                this.webSocketManager = new WebSocketManager(
                    this.tokenManager,
                    this.handleChatMessage.bind(this),
                    this.handleRedemption.bind(this),
                    this.handleStreamOffline.bind(this),
                    this.handleStreamOnline.bind(this),
                    this.handleFollow.bind(this)
                );

                this.webSocketManager.onSessionReady = async (sessionId) => {
                    logger.debug('Bot', 'WebSocket session ready in full mode', { sessionId });
                    if (!this.subscriptionManager) {
                        this.subscriptionManager = new SubscriptionManager(this.tokenManager, sessionId);
                    }
                    this.subscriptionManager.setSessionId(sessionId);
                    await this.subscriptionManager.subscribeToChatEvents();
                    await this.subscriptionManager.subscribeToChannelPoints();
                    await this.subscriptionManager.subscribeToStreamOnline();
                    await this.subscriptionManager.subscribeToStreamOffline();
                    await this.subscriptionManager.subscribeToChannelFollow();
                };

                await this.webSocketManager.connect();
            }

            logger.debug('Bot', 'Starting viewer tracking');
            this.startViewerTracking();

            if (!config.isDebugMode) {
                logger.debug('Bot', 'Starting database backup interval');
                this.startDatabaseBackups();
            }

            logger.info('Bot', 'Bot is now fully operational');

            try {
                await this.sendMessage(this.channelName, 'Bot is live and fully operational');
                logger.debug('Bot', 'Sent startup message to chat');
            } catch (messageError) {
                logger.error('Bot', 'Failed to send startup message to chat', { error: messageError.message });
            }

        } catch (error) {
            logger.error('Bot', 'Error during full operation startup', { error: error.message, stack: error.stack });
            this.isStreaming = false;
            throw error;
        }
    }

    startViewerTracking() {
        if (this.viewerTrackingInterval) {
            logger.debug('Bot', 'Clearing existing viewer tracking interval');
            clearInterval(this.viewerTrackingInterval);
        }

        this.viewerTrackingInterval = setInterval(async () => {
            try {
                if (!this.currentStreamId || !this.isStreaming || this.isShuttingDown) return;

                const broadcasterId = this.tokenManager.tokens.channelId;

                const chatters = await this.twitchAPI.getChatters(broadcasterId, broadcasterId);
                logger.debug('Bot', 'Retrieved chatters list', { count: chatters?.length || 0 });

                await this.viewerManager.processViewerList(chatters, this.currentStreamId);

                const streamData = await this.twitchAPI.getStreamByUserName(this.channelName);
                if (streamData && streamData.viewer_count) {
                    const updateSql = `
                        UPDATE streams
                        SET peak_viewers = GREATEST(peak_viewers, ?)
                        WHERE stream_id = ?
                    `;
                    await this.dbManager.query(updateSql, [streamData.viewer_count, this.currentStreamId]);
                    logger.debug('Bot', 'Updated peak viewer count', { peakViewers: streamData.viewer_count });
                }
            } catch (error) {
                logger.error('Bot', 'Error tracking viewer sessions and count', { error: error.message });
            }
        }, config.viewerTrackingInterval);

        logger.info('Bot', 'Viewer tracking started', { intervalMs: config.viewerTrackingInterval });
    }

    startDatabaseBackups() {
        if (this.backupInterval) {
            logger.debug('Bot', 'Clearing existing backup interval');
            clearInterval(this.backupInterval);
        }

        this.backupManager.createBackup('stream-start')
            .then((success) => {
                if (success) {
                    logger.info('Bot', 'Initial database backup completed');
                } else {
                    logger.warn('Bot', 'Initial database backup failed');
                }
            })
            .catch((error) => {
                logger.error('Bot', 'Error creating initial backup', { error: error.message });
            });

        this.backupInterval = setInterval(async () => {
            try {
                if (!this.isStreaming || this.isShuttingDown) return;

                logger.info('Bot', 'Creating scheduled database backup');
                const success = await this.backupManager.createBackup('scheduled');
                if (success) {
                    logger.info('Bot', 'Scheduled database backup completed');
                } else {
                    logger.warn('Bot', 'Scheduled database backup failed');
                }
            } catch (error) {
                logger.error('Bot', 'Error in backup interval', { error: error.message });
            }
        }, config.backupInterval);

        logger.info('Bot', 'Database backup interval started', { intervalMs: config.backupInterval });
    }

    async handleChatMessage(payload) {
        if (!this.isStreaming || this.isShuttingDown) {
            logger.debug('Bot', 'Ignoring chat message - not streaming or shutting down');
            return;
        }
        logger.debug('Bot', 'Handling chat message', { userId: payload.chatter_user_id, userName: payload.chatter_user_name });
        await this.chatMessageHandler.handleChatMessage(payload, this);
    }

    async handleRedemption(payload) {
        if (!this.isStreaming || this.isShuttingDown) {
            logger.debug('Bot', 'Ignoring redemption - not streaming or shutting down');
            return;
        }
        logger.debug('Bot', 'Handling redemption', { userId: payload.user_id, userName: payload.user_name, reward: payload.reward?.title });
        await this.redemptionHandler.handleRedemption(payload, this);
    }

    async handleFollow(event) {
        try {
            logger.debug('Bot', 'Handling follow event', {
                userId: event.user_id,
                userName: event.user_name,
                followedAt: event.followed_at
            });

            if (!this.viewerManager) {
                logger.warn('Bot', 'ViewerManager not initialized, cannot process follow event');
                return;
            }

            await this.viewerManager.handleFollowEvent(
                event.user_id,
                event.user_name,
                event.followed_at
            );

            logger.info('Bot', 'Follow event processed successfully', {
                userId: event.user_id,
                userName: event.user_name
            });
        } catch (error) {
            logger.error('Bot', 'Error handling follow event', {
                error: error.message,
                stack: error.stack,
                userId: event.user_id,
                userName: event.user_name
            });
        }
    }

    async handleStreamOnline() {
        logger.info('Bot', 'Stream went online! Starting full bot functionality');

        if (this.shutdownTimer) {
            logger.info('Bot', 'Stream came back online during grace period! Cancelling auto-shutdown');
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
        }

        await this.startFullOperation();

        if (!config.isDebugMode) {
            logger.info('Bot', `Scheduling Discord notification in ${config.discord.notificationDelay / 1000} seconds`);
            setTimeout(async () => {
                try {
                    await this.sendDiscordStreamNotification();
                } catch (error) {
                    logger.error('Bot', 'Error sending Discord notification', {
                        error: error.message,
                        stack: error.stack
                    });
                }
            }, config.discord.notificationDelay);
        }
    }

    async sendDiscordStreamNotification() {
        if (!this.currentStreamId || !this.dbManager) {
            logger.warn('Bot', 'Cannot send Discord notification - no active stream or database');
            return;
        }

        try {
            logger.debug('Bot', 'Checking Discord notification cooldown');

            const cooldownSql = `
                SELECT token_value
                FROM tokens
                WHERE token_key = ?
            `;
            const cooldownResults = await this.dbManager.query(cooldownSql, ['lastDiscordNotification']);

            if (cooldownResults && cooldownResults.length > 0) {
                const lastNotificationTime = new Date(cooldownResults[0].token_value);
                const currentTime = new Date();
                const timeSinceLastNotification = currentTime - lastNotificationTime;

                if (timeSinceLastNotification < config.discord.notificationCooldown) {
                    const remainingTime = Math.ceil((config.discord.notificationCooldown - timeSinceLastNotification) / 1000 / 60);
                    logger.info('Bot', 'Discord notification cooldown active, skipping notification', {
                        lastNotificationTime: lastNotificationTime.toISOString(),
                        timeSinceLastNotification: Math.floor(timeSinceLastNotification / 1000 / 60),
                        remainingMinutes: remainingTime
                    });
                    return;
                }

                logger.debug('Bot', 'Cooldown period has passed, proceeding with notification', {
                    lastNotificationTime: lastNotificationTime.toISOString(),
                    timeSinceLastNotification: Math.floor(timeSinceLastNotification / 1000 / 60)
                });
            } else {
                logger.debug('Bot', 'No previous Discord notification found, this is the first notification');
            }

            logger.debug('Bot', 'Fetching stream information for Discord notification', {
                streamId: this.currentStreamId
            });

            const sql = `
                SELECT title, category
                FROM streams
                WHERE stream_id = ?
            `;
            const results = await this.dbManager.query(sql, [this.currentStreamId]);

            if (results && results.length > 0) {
                const { title, category } = results[0];
                logger.info('Bot', 'Sending Discord notification', { title, category });
                await this.discordNotifier.sendStreamLiveNotification(title, category);

                const currentTime = new Date();
                const updateSql = `
                    INSERT INTO tokens (token_key, token_value)
                    VALUES (?, ?)
                    ON DUPLICATE KEY UPDATE token_value = ?, updated_at = CURRENT_TIMESTAMP
                `;
                await this.dbManager.query(updateSql, [
                    'lastDiscordNotification',
                    currentTime.toISOString(),
                    currentTime.toISOString()
                ]);

                logger.debug('Bot', 'Updated last Discord notification timestamp', {
                    timestamp: currentTime.toISOString()
                });
            } else {
                logger.warn('Bot', 'No stream data found in database for Discord notification', {
                    streamId: this.currentStreamId
                });
            }
        } catch (error) {
            logger.error('Bot', 'Failed to send Discord stream notification', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async handleStreamOffline() {
        logger.info('Bot', 'Stream went offline. Stopping full bot functionality');

        try {
            if (this.isStreaming && this.messageSender) {
                try {
                    await this.sendMessage(this.channelName, '🤖 Bot going offline. See you next stream!');
                    logger.debug('Bot', 'Sent offline message to chat');
                } catch (messageError) {
                    logger.error('Bot', 'Failed to send offline message to chat', { error: messageError.message });
                }
            }

            if (this.currentStreamId && this.analyticsManager) {
                logger.debug('Bot', 'Ending stream session', { streamId: this.currentStreamId });
                await this.viewerManager.endAllSessionsForStream(this.currentStreamId);
                await this.analyticsManager.trackStreamEnd(this.currentStreamId);
                this.currentStreamId = null;
            }

            if (this.viewerTrackingInterval) {
                logger.debug('Bot', 'Stopping viewer tracking');
                clearInterval(this.viewerTrackingInterval);
                this.viewerTrackingInterval = null;
            }

            if (this.backupInterval) {
                logger.debug('Bot', 'Stopping database backup interval');
                clearInterval(this.backupInterval);
                this.backupInterval = null;
            }

            this.isStreaming = false;

            if (this.webSocketManager) {
                logger.debug('Bot', 'Removing chat and redemption handlers from WebSocket');
                this.webSocketManager.chatHandler = null;
                this.webSocketManager.redemptionHandler = null;
            }

            if (this.subscriptionManager) {
                try {
                    logger.debug('Bot', 'Unsubscribing from chat and channel point events');
                    await this.subscriptionManager.unsubscribeFromChatEvents();
                    await this.subscriptionManager.unsubscribeFromChannelPoints();
                } catch (unsubError) {
                    logger.error('Bot', 'Error unsubscribing from events', { error: unsubError.message });
                }
            }

            logger.info('Bot', 'Bot successfully transitioned to minimal mode. Waiting for next stream');

            this.startShutdownTimer();

        } catch (error) {
            logger.error('Bot', 'Error during stream offline transition', { error: error.message, stack: error.stack });
            this.isStreaming = false;
        }
    }

    startShutdownTimer() {
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
        }

        const gracePeriodMs = config.shutdownGracePeriod;
        const gracePeriodMinutes = gracePeriodMs / 60000;

        logger.info('Bot', `Auto-shutdown timer started - bot will shutdown in ${gracePeriodMinutes} minutes if stream doesn't restart`, {
            gracePeriodMs,
            gracePeriodMinutes
        });

        const warnings = [
            { time: gracePeriodMs - 15 * 60000, message: '15 minutes until auto-shutdown' },
            { time: gracePeriodMs - 5 * 60000, message: '5 minutes until auto-shutdown' },
            { time: gracePeriodMs - 1 * 60000, message: '1 minute until auto-shutdown' }
        ];

        warnings.forEach(({ time, message }) => {
            if (time > 0) {
                setTimeout(() => {
                    if (!this.isStreaming && !this.isShuttingDown) {
                        logger.warn('Bot', message);
                    }
                }, time);
            }
        });

        this.shutdownTimer = setTimeout(async () => {
            if (!this.isStreaming && !this.isShuttingDown) {
                logger.info('Bot', 'Grace period expired - initiating auto-shutdown');
                await this.gracefulShutdown('Auto-shutdown after grace period');
            }
        }, gracePeriodMs);
    }

    async cleanupOrphanedSessions() {
        try {
            logger.info('Bot', 'Checking for orphaned sessions from previous crashes');

            const streamWithChatSql = `
                UPDATE streams s
                SET end_time = (
                    SELECT MAX(message_time)
                    FROM chat_messages
                    WHERE stream_id = s.stream_id
                )
                WHERE s.end_time IS NULL
                  AND EXISTS (
                    SELECT 1 FROM chat_messages WHERE stream_id = s.stream_id
                )
            `;
            const streamWithChatResult = await this.dbManager.query(streamWithChatSql);

            const streamNoChatSql = `
                UPDATE streams
                SET end_time = NOW()
                WHERE end_time IS NULL
            `;
            const streamNoChatResult = await this.dbManager.query(streamNoChatSql);

            const totalStreamsFixed = streamWithChatResult.affectedRows + streamNoChatResult.affectedRows;

            if (totalStreamsFixed > 0) {
                logger.warn('Bot', 'Closed orphaned streams from previous crash', {
                    orphanedStreams: totalStreamsFixed,
                    fixedWithChatData: streamWithChatResult.affectedRows,
                    fixedWithNOW: streamNoChatResult.affectedRows
                });
            } else {
                logger.debug('Bot', 'No orphaned streams found');
            }

            const sessionWithChatSql = `
                UPDATE viewing_sessions vs
                SET end_time = (
                    SELECT MAX(message_time)
                    FROM chat_messages cm
                    WHERE cm.user_id = vs.user_id
                      AND cm.stream_id = vs.stream_id
                )
                WHERE vs.end_time IS NULL
                  AND EXISTS (
                    SELECT 1 FROM chat_messages
                    WHERE user_id = vs.user_id AND stream_id = vs.stream_id
                )
            `;
            const sessionWithChatResult = await this.dbManager.query(sessionWithChatSql);

            const sessionFallbackSql = `
                UPDATE viewing_sessions vs
                SET end_time = COALESCE(
                    (SELECT end_time FROM streams WHERE stream_id = vs.stream_id),
                    NOW()
                )
                WHERE vs.end_time IS NULL
            `;
            const sessionFallbackResult = await this.dbManager.query(sessionFallbackSql);

            const totalSessionsFixed = sessionWithChatResult.affectedRows + sessionFallbackResult.affectedRows;

            if (totalSessionsFixed > 0) {
                logger.warn('Bot', 'Closed orphaned viewing sessions from previous crash', {
                    orphanedSessions: totalSessionsFixed,
                    fixedWithUserMessages: sessionWithChatResult.affectedRows,
                    fixedWithFallback: sessionFallbackResult.affectedRows
                });
            } else {
                logger.debug('Bot', 'No orphaned viewing sessions found');
            }

            logger.info('Bot', 'Orphaned session cleanup complete', {
                sessionsFixed: totalSessionsFixed,
                streamsFixed: totalStreamsFixed,
                usingAccurateTimestamps: (streamWithChatResult.affectedRows + sessionWithChatResult.affectedRows) > 0
            });

        } catch (error) {
            logger.error('Bot', 'Error during orphaned session cleanup', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async gracefulShutdown(reason = 'Manual shutdown') {
        if (this.isShuttingDown) {
            logger.warn('Bot', 'Shutdown already in progress, ignoring duplicate call');
            return;
        }

        this.isShuttingDown = true;
        logger.info('Bot', '=== Initiating graceful shutdown ===', { reason });

        try {
            if (this.shutdownTimer) {
                logger.debug('Bot', 'Clearing shutdown timer');
                clearTimeout(this.shutdownTimer);
                this.shutdownTimer = null;
            }

            if (this.currentStreamId && this.viewerManager && this.analyticsManager) {
                logger.info('Bot', 'Saving stream data before shutdown', { streamId: this.currentStreamId });
                try {
                    await this.viewerManager.endAllSessionsForStream(this.currentStreamId);
                    await this.analyticsManager.trackStreamEnd(this.currentStreamId);
                    logger.info('Bot', 'Stream data saved successfully');
                } catch (error) {
                    logger.error('Bot', 'Error saving stream data during shutdown', { error: error.message, stack: error.stack });
                }
            }

            if (this.viewerTrackingInterval) {
                logger.debug('Bot', 'Clearing viewer tracking interval');
                clearInterval(this.viewerTrackingInterval);
                this.viewerTrackingInterval = null;
            }

            if (this.tokenRefreshInterval) {
                logger.debug('Bot', 'Clearing token refresh interval');
                clearInterval(this.tokenRefreshInterval);
                this.tokenRefreshInterval = null;
            }

            if (this.backupInterval) {
                logger.debug('Bot', 'Clearing backup interval');
                clearInterval(this.backupInterval);
                this.backupInterval = null;
            }

            if (this.backupManager && !config.isDebugMode) {
                logger.info('Bot', 'Creating final database backup before shutdown');
                try {
                    const success = await this.backupManager.createBackup('shutdown');
                    if (success) {
                        logger.info('Bot', 'Final database backup completed');
                    } else {
                        logger.warn('Bot', 'Final database backup failed');
                    }
                } catch (error) {
                    logger.error('Bot', 'Error creating final backup', { error: error.message });
                }
            }

            if (this.apiServer) {
                logger.info('Bot', 'Stopping API server');
                try {
                    await this.apiServer.stop();
                } catch (error) {
                    logger.error('Bot', 'Error stopping API server', { error: error.message });
                }
            }

            if (this.webSocketManager) {
                logger.info('Bot', 'Closing WebSocket connection');
                try {
                    this.webSocketManager.close();
                } catch (error) {
                    logger.error('Bot', 'Error closing WebSocket', { error: error.message });
                }
            }

            if (this.dbManager) {
                logger.info('Bot', 'Closing database connection');
                try {
                    await this.dbManager.close();
                    logger.info('Bot', 'Database connection closed successfully');
                } catch (error) {
                    logger.error('Bot', 'Error closing database connection', { error: error.message, stack: error.stack });
                }
            }

            if (config.isDebugMode) {
                const debugDbName = process.env.DB_NAME + '_debug';
                logger.info('Bot', '=== DEBUG MODE SHUTDOWN ===');
                logger.info('Bot', `Debug database preserved for review: ${debugDbName}`);
                logger.info('Bot', 'Debug database will be recreated on next debug startup');
            }

            logger.info('Bot', '=== Graceful shutdown complete ===');

            process.exit(0);

        } catch (error) {
            logger.error('Bot', 'Error during graceful shutdown', { error: error.message, stack: error.stack });
            process.exit(1);
        }
    }

    async sendMessage(channel, message) {
        if (!this.isStreaming || !this.messageSender || this.isShuttingDown) {
            logger.debug('Bot', 'Cannot send message - bot not streaming, sender not initialized, or shutting down');
            return;
        }
        logger.debug('Bot', 'Sending message to chat', { channel, messageLength: message.length });
        return this.messageSender.sendMessage(channel, message);
    }
}

const bot = new Bot();

process.on('SIGINT', async () => {
    logger.info('Bot', 'Received SIGINT (Ctrl+C) - initiating graceful shutdown');
    await bot.gracefulShutdown('SIGINT (Ctrl+C)');
});

process.on('SIGTERM', async () => {
    logger.info('Bot', 'Received SIGTERM - initiating graceful shutdown');
    await bot.gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Bot', 'Unhandled Promise Rejection', {
        reason: reason?.message || reason,
        stack: reason?.stack,
        promise: promise
    });
});

process.on('uncaughtException', (error) => {
    logger.error('Bot', 'Uncaught Exception - initiating emergency shutdown', {
        error: error.message,
        stack: error.stack
    });
    setTimeout(() => process.exit(1), 1000);
});

async function startBot() {
    try {
        logger.info('Bot', '=== Starting Twitch Bot ===');
        await bot.init();
    } catch (error) {
        logger.error('Bot', 'Failed to start bot - exiting', { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

if (process.env.NODE_ENV !== 'test') {
    startBot();
}

module.exports = Bot;
