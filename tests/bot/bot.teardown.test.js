/**
 * Runtime teardown across stream cycles (P0-4 extended).
 *
 * SpotifyManager is deliberately NOT automocked: its polling loops are the thing
 * that used to leak, so the leak test counts real fake-timer handles. Only its
 * outbound dependencies (the Spotify HTTP client and the DB-backed queue) are
 * stubbed.
 */

const Bot = require('../../src/bot');

jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    channelName: 'testchannel',
    apiEnabled: true,
    apiPort: 34119,
    apiKey: 'test-key',
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
    spotifyInterval: 3000,
    analyticsQueue: { drainTimeoutMs: 30000 }
}));

jest.mock('spotify-web-api-node');
jest.mock('../../src/redemptions/songs/queueManager');

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
jest.mock('../../src/redemptions/redemptionManager');
jest.mock('../../src/messages/messageSender');
jest.mock('../../src/messages/chatMessageHandler');
jest.mock('../../src/messages/redemptionHandler');
jest.mock('../../src/websocket/webSocketManager');
jest.mock('../../src/websocket/subscriptionManager');
jest.mock('../../src/notifications/discordNotifier');
jest.mock('../../src/services/songToggleService');
jest.mock('../../src/api/apiServer');
// NOTE: src/redemptions/songs/spotifyManager is intentionally NOT mocked.

const SpotifyWebApi = require('spotify-web-api-node');
const DbBackupManager = require('../../src/database/dbBackupManager');
const QueueManager = require('../../src/redemptions/songs/queueManager');
const SpotifyManager = require('../../src/redemptions/songs/spotifyManager');
const ApiServer = require('../../src/api/apiServer');
const SongToggleService = require('../../src/services/songToggleService');
const MessageSender = require('../../src/messages/messageSender');
const TokenManager = require('../../src/tokens/tokenManager');
const TwitchAPI = require('../../src/tokens/twitchAPI');
const AnalyticsManager = require('../../src/analytics/analyticsManager');
const CommandManager = require('../../src/commands/commandManager');
const WebSocketManager = require('../../src/websocket/webSocketManager');
const SubscriptionManager = require('../../src/websocket/subscriptionManager');

describe('Bot - runtime teardown', () => {
    let bot;
    let mockApiServer;
    let mockSubscriptionManager;
    let mockWebSocketManager;
    let spotifyConstructorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.spyOn(process, 'exit').mockImplementation(() => {});

        DbBackupManager.mockImplementation(() => ({
            createBackup: jest.fn().mockResolvedValue(true),
            cleanup: jest.fn().mockResolvedValue(undefined)
        }));

        SpotifyWebApi.mockImplementation(() => ({
            setAccessToken: jest.fn(),
            setRefreshToken: jest.fn(),
            getMe: jest.fn().mockResolvedValue({ body: { id: 'user' } }),
            refreshAccessToken: jest.fn().mockResolvedValue({ body: { access_token: 'new' } }),
            getMyCurrentPlaybackState: jest.fn().mockResolvedValue({
                body: {
                    device: { id: 'd' },
                    is_playing: true,
                    item: { id: 't', duration_ms: 180000 },
                    progress_ms: 1000
                }
            }),
            getMyCurrentPlayingTrack: jest.fn().mockResolvedValue({ body: { item: null } }),
            addToQueue: jest.fn().mockResolvedValue(true)
        }));

        QueueManager.mockImplementation(() => ({
            init: jest.fn().mockResolvedValue(undefined),
            getPendingTracks: jest.fn().mockResolvedValue([]),
            removeFirstTrack: jest.fn().mockResolvedValue(undefined)
        }));

        spotifyConstructorSpy = jest.spyOn(SpotifyManager.prototype, 'init');

        mockApiServer = {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined)
        };
        ApiServer.mockImplementation(() => mockApiServer);

        SongToggleService.mockImplementation(() => ({ toggle: jest.fn() }));
        MessageSender.mockImplementation(() => ({
            sendMessage: jest.fn().mockResolvedValue(undefined)
        }));

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

        mockWebSocketManager = {
            connect: jest.fn().mockResolvedValue(undefined),
            close: jest.fn(),
            clearReconnectTimer: jest.fn(),
            onChatMessage: null,
            onRedemption: null,
            onFollow: null,
            onSessionReady: null,
            onSessionMoved: null
        };
        WebSocketManager.mockImplementation(() => mockWebSocketManager);

        TokenManager.mockImplementation(() => ({
            init: jest.fn().mockResolvedValue(undefined),
            checkAndRefreshTokens: jest.fn().mockResolvedValue(undefined),
            tokens: {
                channelId: 'channel-123',
                userId: 'user-123',
                claudeApiKey: 'k',
                spotifyClientId: 'sid',
                spotifyClientSecret: 'secret',
                spotifyUserAccessToken: 'spotify-access',
                spotifyUserRefreshToken: 'spotify-refresh'
            },
            saveTokens: jest.fn().mockResolvedValue(undefined)
        }));

        TwitchAPI.mockImplementation(() => ({
            getStreamByUserName: jest.fn().mockResolvedValue({ viewer_count: 5 }),
            getChannelInfo: jest.fn().mockResolvedValue({ title: 'T', game_name: 'G' }),
            getChatters: jest.fn().mockResolvedValue([])
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
            init: jest.fn().mockResolvedValue(undefined)
        });

        bot = new Bot();
        bot.tokenManager = new TokenManager();
        bot.twitchAPI = new TwitchAPI();
        bot.dbManager = {
            query: jest.fn().mockResolvedValue({ affectedRows: 0 }),
            close: jest.fn().mockResolvedValue(undefined)
        };
        bot.redisManager = null;
    });

    afterEach(() => {
        // A test may have stubbed stop() to throw; cleanup must not care.
        try {
            if (bot.spotifyManager) bot.spotifyManager.stop();
        } catch {
            // ignored
        }
        bot.stopViewerTracking();
        bot.stopDatabaseBackups();
        bot.clearShutdownTimer();
        clearInterval(bot.tokenRefreshInterval);
        jest.useRealTimers();
    });

    describe('two full stream cycles', () => {
        it('should leak no timers across online -> offline -> online -> offline', async () => {
            await bot.startFullOperation();
            const onlineTimers = jest.getTimerCount();

            await bot.handleStreamOffline();
            const offlineTimers = jest.getTimerCount();

            await bot.startFullOperation();
            expect(jest.getTimerCount()).toBe(onlineTimers);

            await bot.handleStreamOffline();
            expect(jest.getTimerCount()).toBe(offlineTimers);
        });

        it('should leak no timers across five cycles', async () => {
            await bot.startFullOperation();
            const baseline = jest.getTimerCount();

            for (let cycle = 0; cycle < 5; cycle++) {
                await bot.handleStreamOffline();
                await bot.startFullOperation();
            }

            expect(jest.getTimerCount()).toBe(baseline);
        });

        it('should keep exactly one SpotifyManager across cycles', async () => {
            await bot.startFullOperation();
            const first = bot.spotifyManager;

            await bot.handleStreamOffline();
            await bot.startFullOperation();

            expect(bot.spotifyManager).toBe(first);
            expect(spotifyConstructorSpy).toHaveBeenCalledTimes(2);
        });

        it('should run exactly three Spotify monitors while live', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            await bot.startFullOperation();

            expect(bot.spotifyManager.isMonitoring()).toBe(true);

            // Two sets racing the same song queue was the double-queue/double-delete
            // bug. Three loops, not six.
            const monitors = [
                bot.spotifyManager.playbackMonitor,
                bot.spotifyManager.lastSongMonitor,
                bot.spotifyManager.queueMonitor
            ];
            expect(new Set(monitors).size).toBe(3);
        });

        it('should stop the Spotify monitors on every offline transition', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();

            expect(bot.spotifyManager.isMonitoring()).toBe(false);

            await bot.startFullOperation();
            await bot.handleStreamOffline();

            expect(bot.spotifyManager.isMonitoring()).toBe(false);
        });

        it('should build the API server once and never collide on its port', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            await bot.startFullOperation();

            expect(ApiServer).toHaveBeenCalledTimes(1);
            expect(mockApiServer.start).toHaveBeenCalledTimes(3);
        });

        it('should reuse the song toggle service and message sender', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            await bot.startFullOperation();

            expect(SongToggleService).toHaveBeenCalledTimes(1);
            expect(MessageSender).toHaveBeenCalledTimes(1);
        });

        it('should clear the viewer and backup intervals on every offline', async () => {
            for (let cycle = 0; cycle < 3; cycle++) {
                await bot.startFullOperation();
                expect(bot.viewerTrackingInterval).not.toBeNull();
                expect(bot.backupInterval).not.toBeNull();

                await bot.handleStreamOffline();
                expect(bot.viewerTrackingInterval).toBeNull();
                expect(bot.backupInterval).toBeNull();
            }
        });

        it('should not leave a shutdown timer armed after coming back online', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            expect(bot.shutdownTimer).not.toBeNull();

            await bot.startFullOperation();

            expect(bot.shutdownTimer).toBeNull();
            expect(bot.shutdownWarningTimers).toHaveLength(0);
        });

        it('should not queue songs after going offline', async () => {
            await bot.startFullOperation();
            const spotifyApi = bot.spotifyManager.spotifyApi;

            await bot.handleStreamOffline();
            jest.clearAllMocks();

            await jest.advanceTimersByTimeAsync(60000);

            expect(spotifyApi.getMyCurrentPlaybackState).not.toHaveBeenCalled();
        });
    });

    describe('resilient offline teardown', () => {
        const failingStep = async (setup) => {
            await bot.startFullOperation();
            setup();
            await bot.handleStreamOffline();
        };

        it('should complete teardown when ending the stream session throws', async () => {
            await failingStep(() => {
                bot.viewerManager.endAllSessionsForStream
                    .mockRejectedValue(new Error('DB unreachable'));
            });

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.backupInterval).toBeNull();
            expect(bot.spotifyManager.isMonitoring()).toBe(false);
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should complete teardown when the viewer manager is missing entirely', async () => {
            await failingStep(() => {
                bot.viewerManager = undefined;
            });

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should complete teardown when the offline chat message throws', async () => {
            await failingStep(() => {
                bot.messageSender.sendMessage.mockRejectedValue(new Error('Twitch 500'));
            });

            expect(bot.isStreaming).toBe(false);
            expect(bot.spotifyManager.isMonitoring()).toBe(false);
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should complete teardown when unsubscribing throws', async () => {
            await failingStep(() => {
                mockSubscriptionManager.unsubscribeFromChatEvents
                    .mockRejectedValue(new Error('Twitch API down'));
            });

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should complete teardown when stopping the Spotify monitors throws', async () => {
            await failingStep(() => {
                jest.spyOn(bot.spotifyManager, 'stop').mockImplementation(() => {
                    throw new Error('unexpected');
                });
            });

            expect(bot.isStreaming).toBe(false);
            expect(bot.viewerTrackingInterval).toBeNull();
            expect(bot.shutdownTimer).not.toBeNull();
        });

        it('should still detach the WebSocket handlers when a step throws', async () => {
            await failingStep(() => {
                bot.viewerManager.endAllSessionsForStream
                    .mockRejectedValue(new Error('DB unreachable'));
            });

            expect(mockWebSocketManager.onChatMessage).toBeNull();
            expect(mockWebSocketManager.onRedemption).toBeNull();
        });

        it('should leave no timer leak when a teardown step throws', async () => {
            await bot.startFullOperation();
            const onlineTimers = jest.getTimerCount();

            bot.viewerManager.endAllSessionsForStream
                .mockRejectedValue(new Error('DB unreachable'));
            await bot.handleStreamOffline();
            const offlineTimers = jest.getTimerCount();

            await bot.startFullOperation();

            expect(jest.getTimerCount()).toBe(onlineTimers);
            expect(offlineTimers).toBeLessThan(onlineTimers);
        });
    });

    describe('shutdown warning timers', () => {
        beforeEach(() => {
            bot.isStreaming = false;
        });

        it('should track the warning timers it schedules', () => {
            bot.startShutdownTimer();

            expect(bot.shutdownWarningTimers).toHaveLength(3);
        });

        it('should clear the warning timers when the shutdown is cancelled', () => {
            bot.startShutdownTimer();

            bot.clearShutdownTimer();

            expect(bot.shutdownWarningTimers).toHaveLength(0);
            expect(bot.shutdownTimer).toBeNull();
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should not stack warning timers when restarted', () => {
            bot.startShutdownTimer();
            bot.startShutdownTimer();
            bot.startShutdownTimer();

            expect(bot.shutdownWarningTimers).toHaveLength(3);
            // Three warnings plus the shutdown itself.
            expect(jest.getTimerCount()).toBe(4);
        });

        it('should clear the warning timers when the stream returns', async () => {
            bot.startShutdownTimer();
            bot.startFullOperation = jest.fn().mockResolvedValue(undefined);
            bot.sendDiscordStreamNotification = jest.fn().mockResolvedValue(undefined);

            await bot.handleStreamOnline();

            expect(bot.shutdownWarningTimers).toHaveLength(0);
        });
    });

    describe('graceful shutdown', () => {
        it('should stop the Spotify monitors and the API server', async () => {
            await bot.startFullOperation();

            await bot.gracefulShutdown('test');

            expect(bot.spotifyManager.isMonitoring()).toBe(false);
            expect(mockApiServer.stop).toHaveBeenCalled();
        });

        it('should leave no timers running', async () => {
            await bot.startFullOperation();

            await bot.gracefulShutdown('test');

            expect(jest.getTimerCount()).toBe(0);
        });

        it('should leave no timers running when shutting down from offline', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();

            await bot.gracefulShutdown('test');

            expect(jest.getTimerCount()).toBe(0);
        });
    });
    describe('startup rollback (WP-4.1)', () => {
        /**
         * Three different startup steps, each made to fail, to prove the rollback
         * does not depend on how far startup got before it broke.
         */
        const failureMatrix = [
            {
                name: 'early - analytics init',
                fail: () => {
                    AnalyticsManager.mockImplementation(() => ({
                        init: jest.fn().mockRejectedValue(new Error('analytics down')),
                        viewerTracker: {}
                    }));
                }
            },
            {
                name: 'midway - Spotify auth throws after monitors could start',
                fail: () => {
                    CommandManager.createWithDependencies = jest.fn(() => {
                        throw new Error('command registry unavailable');
                    });
                }
            },
            {
                name: 'late - subscribing to chat events',
                fail: (bot) => {
                    // In production the session-ready callback creates this; the
                    // mocked WebSocketManager never fires it, so wire it by hand.
                    bot.subscriptionManager = mockSubscriptionManager;
                    mockSubscriptionManager.subscribeToChatEvents
                        .mockRejectedValue(new Error('Twitch rejected subscription'));
                }
            }
        ];

        failureMatrix.forEach(({ name, fail }) => {
            describe(`when startup fails ${name}`, () => {
                beforeEach(async () => {
                    // A prior successful cycle so there is real state to roll back.
                    await bot.startFullOperation();
                    await bot.handleStreamOffline();
                    bot.clearShutdownTimer();
                    fail(bot);
                });

                it('should reject', async () => {
                    await expect(bot.startFullOperation()).rejects.toThrow();
                });

                it('should leave nothing streaming', async () => {
                    await bot.startFullOperation().catch(() => {});

                    expect(bot.isStreaming).toBe(false);
                    expect(bot.currentStreamId).toBeNull();
                });

                it('should leave no intervals or monitors running', async () => {
                    await bot.startFullOperation().catch(() => {});

                    expect(bot.viewerTrackingInterval).toBeNull();
                    expect(bot.backupInterval).toBeNull();
                    expect(bot.spotifyManager.isMonitoring()).toBe(false);
                });

                it('should detach the streaming WebSocket handlers', async () => {
                    await bot.startFullOperation().catch(() => {});

                    expect(mockWebSocketManager.onChatMessage).toBeNull();
                    expect(mockWebSocketManager.onRedemption).toBeNull();
                });

                it('should arm the grace timer so the next stream is the retry', async () => {
                    await bot.startFullOperation().catch(() => {});

                    expect(bot.shutdownTimer).not.toBeNull();
                });

                it('should come back online cleanly once the fault clears', async () => {
                    await bot.startFullOperation().catch(() => {});

                    // Restore the healthy fixtures and try again.
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
                        init: jest.fn().mockResolvedValue(undefined)
                    });
                    mockSubscriptionManager.subscribeToChatEvents
                        .mockResolvedValue(undefined);

                    await expect(bot.startFullOperation()).resolves.toBeUndefined();

                    expect(bot.isStreaming).toBe(true);
                    expect(bot.spotifyManager.isMonitoring()).toBe(true);
                    expect(bot.shutdownTimer).toBeNull();
                });
            });
        });

        it('should not leak timers when a startup failure follows a good cycle', async () => {
            await bot.startFullOperation();
            await bot.handleStreamOffline();
            const offlineTimers = jest.getTimerCount();

            bot.subscriptionManager = mockSubscriptionManager;
            mockSubscriptionManager.subscribeToChatEvents
                .mockRejectedValue(new Error('Twitch rejected subscription'));
            await bot.startFullOperation().catch(() => {});

            expect(jest.getTimerCount()).toBe(offlineTimers);
        });
    });

    describe('Spotify auth-dead startup', () => {
        it('should not start monitors when Spotify auth is dead', async () => {
            jest.spyOn(SpotifyManager.prototype, 'authenticate').mockResolvedValue(false);

            await bot.startFullOperation();

            expect(bot.isStreaming).toBe(true);
            expect(bot.spotifyManager.isMonitoring()).toBe(false);
        });

        it('should still complete startup with song monitors disabled', async () => {
            jest.spyOn(SpotifyManager.prototype, 'authenticate').mockResolvedValue(false);

            await expect(bot.startFullOperation()).resolves.toBeUndefined();

            expect(bot.viewerTrackingInterval).not.toBeNull();
        });
    });
});
