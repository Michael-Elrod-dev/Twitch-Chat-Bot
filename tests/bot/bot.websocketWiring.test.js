/**
 * Wiring contract between Bot and the REAL WebSocketManager.
 *
 * WebSocketManager is deliberately NOT automocked here. These tests drive synthetic
 * EventSub frames through the real message dispatcher and assert the bot takes the
 * matching transition. This is the regression net for P0-1, where the two stream
 * handlers were passed to the constructor in swapped positions: a stream going live
 * ran the offline teardown and armed the auto-shutdown timer.
 */

const Bot = require('../../src/bot');

jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    channelName: 'testchannel',
    apiEnabled: false,
    wsEndpoint: 'wss://eventsub.wss.twitch.tv/ws',
    wsReconnectDelay: 5000,
    database: {
        host: 'localhost',
        port: 3306,
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    },
    discord: {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        notificationDelay: 30000,
        notificationCooldown: 14400000
    },
    twitchChannelUrl: 'https://www.twitch.tv/testchannel',
    tokenRefreshInterval: 300000,
    viewerTrackingInterval: 60000,
    backupInterval: 3600000,
    shutdownGracePeriod: 1800000,
    analyticsQueue: { drainTimeoutMs: 30000 }
}));

jest.mock('ws');

jest.mock('../../src/database/dbManager');
jest.mock('../../src/database/dbBackupManager');
jest.mock('../../src/database/debugDbSetup');
jest.mock('../../src/redis/redisManager');
jest.mock('../../src/tokens/tokenManager');
jest.mock('../../src/tokens/twitchAPI');
jest.mock('../../src/ai/aiManager');
jest.mock('../../src/emotes/emoteManager');
jest.mock('../../src/commands/commandManager');
jest.mock('../../src/analytics/analyticsManager');
jest.mock('../../src/redemptions/quotes/quoteManager');
jest.mock('../../src/redemptions/songs/spotifyManager');
jest.mock('../../src/redemptions/redemptionManager');
jest.mock('../../src/messages/messageSender');
jest.mock('../../src/messages/chatMessageHandler');
jest.mock('../../src/messages/redemptionHandler');
jest.mock('../../src/websocket/subscriptionManager');
jest.mock('../../src/notifications/discordNotifier');
jest.mock('../../src/services/songToggleService');
jest.mock('../../src/api/apiServer');
// NOTE: src/websocket/webSocketManager is intentionally NOT mocked.

const WebSocket = require('ws');
const SubscriptionManager = require('../../src/websocket/subscriptionManager');
const TokenManager = require('../../src/tokens/tokenManager');
const TwitchAPI = require('../../src/tokens/twitchAPI');
const DbManager = require('../../src/database/dbManager');
const AnalyticsManager = require('../../src/analytics/analyticsManager');
const CommandManager = require('../../src/commands/commandManager');

const notification = (subscriptionType, payload = {}) => ({
    metadata: {
        message_type: 'notification',
        subscription_type: subscriptionType
    },
    payload
});

const sessionWelcome = (id) => ({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id } }
});

describe('Bot - WebSocket wiring contract', () => {
    let bot;
    let mockSubscriptionManager;
    let sockets;

    /** Every `new WebSocket(url)` records a fake socket we can drive by hand. */
    const newSocket = (url) => {
        const listeners = {};
        const socket = {
            url,
            close: jest.fn(),
            on: jest.fn((event, handler) => {
                listeners[event] = handler;
            }),
            emit: (event, ...args) => listeners[event] && listeners[event](...args),
            deliver: (message) => listeners.message && listeners.message(JSON.stringify(message)),
            listeners
        };
        sockets.push(socket);
        return socket;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.spyOn(process, 'exit').mockImplementation(() => {});

        sockets = [];
        WebSocket.mockImplementation((url) => newSocket(url));

        mockSubscriptionManager = {
            setSessionId: jest.fn(),
            subscribeToChatEvents: jest.fn().mockResolvedValue(undefined),
            subscribeToChannelPoints: jest.fn().mockResolvedValue(undefined),
            subscribeToStreamOnline: jest.fn().mockResolvedValue(undefined),
            subscribeToStreamOffline: jest.fn().mockResolvedValue(undefined),
            subscribeToChannelFollow: jest.fn().mockResolvedValue(undefined),
            unsubscribeFromChatEvents: jest.fn().mockResolvedValue(undefined),
            unsubscribeFromChannelPoints: jest.fn().mockResolvedValue(undefined)
        };
        SubscriptionManager.mockImplementation(() => mockSubscriptionManager);

        TokenManager.mockImplementation(() => ({
            init: jest.fn().mockResolvedValue(undefined),
            checkAndRefreshTokens: jest.fn().mockResolvedValue(undefined),
            tokens: { channelId: 'channel-123', userId: 'user-123', claudeApiKey: 'key' }
        }));

        TwitchAPI.mockImplementation(() => ({
            getStreamByUserName: jest.fn().mockResolvedValue(null),
            getChannelInfo: jest.fn().mockResolvedValue(null),
            getChatters: jest.fn().mockResolvedValue([])
        }));

        DbManager.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            query: jest.fn().mockResolvedValue({ affectedRows: 0 }),
            close: jest.fn().mockResolvedValue(undefined)
        }));

        AnalyticsManager.mockImplementation(() => ({
            init: jest.fn().mockResolvedValue(undefined),
            trackStreamStart: jest.fn().mockResolvedValue(undefined),
            trackStreamEnd: jest.fn().mockResolvedValue(undefined),
            trackChatMessage: jest.fn().mockResolvedValue(undefined),
            viewerTracker: {
                endAllSessionsForStream: jest.fn().mockResolvedValue(undefined),
                processViewerList: jest.fn().mockResolvedValue(undefined),
                handleFollowEvent: jest.fn().mockResolvedValue(true)
            }
        }));

        CommandManager.createWithDependencies = jest.fn().mockReturnValue({
            init: jest.fn().mockResolvedValue(undefined),
            handleCommand: jest.fn().mockResolvedValue(undefined)
        });

        bot = new Bot();
    });

    afterEach(() => {
        clearInterval(bot.viewerTrackingInterval);
        clearInterval(bot.backupInterval);
        clearInterval(bot.tokenRefreshInterval);
        clearTimeout(bot.shutdownTimer);
        if (bot.webSocketManager) bot.webSocketManager.clearReconnectTimer();
        jest.useRealTimers();
    });

    describe('stream.online / stream.offline routing', () => {
        beforeEach(async () => {
            await bot.startMinimalOperation();

            bot.startFullOperation = jest.fn().mockImplementation(async () => {
                bot.isStreaming = true;
            });
            bot.sendDiscordStreamNotification = jest.fn().mockResolvedValue(undefined);
        });

        it('should take the ONLINE transition on a stream.online event', async () => {
            await bot.webSocketManager.handleMessage(notification('stream.online'));

            expect(bot.startFullOperation).toHaveBeenCalled();
        });

        it('should NOT arm the auto-shutdown timer on a stream.online event', async () => {
            // The P0-1 signature: a stream going live ran the offline teardown, which
            // armed the 30-minute auto-shutdown. Under the swapped wiring this fails.
            await bot.webSocketManager.handleMessage(notification('stream.online'));

            expect(bot.shutdownTimer).toBeNull();
            expect(bot.isStreaming).toBe(true);
        });

        it('should cancel a pending shutdown when the stream comes back', async () => {
            bot.isStreaming = false;
            bot.startShutdownTimer();
            expect(bot.shutdownTimer).not.toBeNull();

            await bot.webSocketManager.handleMessage(notification('stream.online'));

            expect(bot.shutdownTimer).toBeNull();
        });

        it('should take the OFFLINE transition on a stream.offline event', async () => {
            bot.isStreaming = true;
            bot.currentStreamId = 'stream-1';
            bot.analyticsManager = {
                trackStreamEnd: jest.fn().mockResolvedValue(undefined)
            };
            bot.viewerManager = {
                endAllSessionsForStream: jest.fn().mockResolvedValue(undefined)
            };

            await bot.webSocketManager.handleMessage(notification('stream.offline'));

            expect(bot.isStreaming).toBe(false);
            expect(bot.analyticsManager.trackStreamEnd).toHaveBeenCalledWith('stream-1');
            expect(bot.startFullOperation).not.toHaveBeenCalled();
        });

        it('should arm the auto-shutdown timer on a stream.offline event', async () => {
            bot.isStreaming = true;

            await bot.webSocketManager.handleMessage(notification('stream.offline'));

            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should route a follow event to the follow handler', async () => {
            bot.viewerManager = {
                handleFollowEvent: jest.fn().mockResolvedValue(true)
            };

            await bot.webSocketManager.handleMessage(notification('channel.follow', {
                event: {
                    user_id: '9',
                    user_name: 'follower',
                    followed_at: '2026-01-15T12:00:00Z'
                }
            }));

            expect(bot.viewerManager.handleFollowEvent)
                .toHaveBeenCalledWith('9', 'follower', '2026-01-15T12:00:00Z');
        });
    });

    describe('mode-aware resubscription', () => {
        it('should subscribe to lifecycle events only while in minimal mode', async () => {
            await bot.startMinimalOperation();

            await bot.webSocketManager.handleMessage(sessionWelcome('session-1'));

            expect(mockSubscriptionManager.subscribeToStreamOnline).toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToStreamOffline).toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToChannelFollow).toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToChatEvents).not.toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToChannelPoints).not.toHaveBeenCalled();
        });

        it('should also subscribe to chat and channel points while streaming', async () => {
            await bot.startMinimalOperation();
            bot.isStreaming = true;

            await bot.webSocketManager.handleMessage(sessionWelcome('session-2'));

            expect(mockSubscriptionManager.subscribeToStreamOnline).toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToChatEvents).toHaveBeenCalled();
            expect(mockSubscriptionManager.subscribeToChannelPoints).toHaveBeenCalled();
        });

        it('should reuse the same SubscriptionManager across sessions', async () => {
            await bot.startMinimalOperation();

            await bot.webSocketManager.handleMessage(sessionWelcome('session-1'));
            const first = bot.subscriptionManager;

            await bot.webSocketManager.handleMessage(sessionWelcome('session-2'));

            expect(bot.subscriptionManager).toBe(first);
            expect(SubscriptionManager).toHaveBeenCalledTimes(1);
            expect(mockSubscriptionManager.setSessionId).toHaveBeenCalledWith('session-2');
        });
    });
});
