import type { Env } from './config/env.js';
import type { Logger } from './logger.js';
import type { Database } from './db/client.js';
import type { CacheManager } from './cache/cacheManager.js';
import type { ChatSink } from './services/chatSink.js';
import type { AiService } from './services/aiService.js';
import type { AnalyticsSink } from './services/analytics.js';
import type { HandlerRegistry } from './domain/handlers.js';
import type { EventBus } from './live/eventBus.js';
import type { ClaudeClient } from './ai/claudeClient.js';
import { ChannelAiService } from './ai/aiService.js';
import { AiRateLimiter } from './ai/rateLimiter.js';
import { ChatHistoryRepository } from './db/repositories/chatHistoryRepository.js';
import { createAiHandlers } from './domain/aiHandlers.js';
import { createSongHandlers } from './domain/songHandlers.js';
import { createStreamHandlers } from './domain/streamHandlers.js';
import { createGameHandlers } from './domain/gameHandlers.js';
import { createStatsHandlers } from './domain/statsHandlers.js';
import { createQuoteHandlers } from './domain/quoteHandlers.js';
import { QuoteManager } from './domain/quoteManager.js';
import { createThirdPartyHandlers } from './domain/thirdPartyHandlers.js';
import { StreamService } from './domain/streamService.js';
import { PresenceTracker } from './domain/presenceTracker.js';
import { StreamRepository } from './db/repositories/streamRepository.js';
import { AnalyticsRepository } from './db/repositories/analyticsRepository.js';
import { PlaylistRepository } from './db/repositories/playlistRepository.js';
import { DatabaseAnalyticsSink } from './services/analytics.js';
import { SongToggleService } from './domain/songToggle.js';
import { createSongRequestHandler, createSkipQueueHandler } from './domain/songRedemption.js';
import { createQuoteRedemptionHandler } from './domain/quoteRedemption.js';
import { RedemptionPipeline } from './session/redemptionPipeline.js';
import { RedemptionSettlement } from './services/redemptionSettlement.js';
import { ChannelRewardRepository } from './db/repositories/channelRewardRepository.js';
import { SongQueueRepository } from './db/repositories/songQueueRepository.js';
import { ChannelTokenRepository } from './db/repositories/channelTokenRepository.js';
import { UserTokenProvider } from './twitch/userTokenProvider.js';
import { HttpSpotifyClient, type SpotifyClient } from './spotify/spotifyClient.js';
import { SpotifyTokenProvider, type SpotifyOAuthConfig } from './spotify/spotifyAuth.js';
import { PlaybackMonitor } from './spotify/playbackMonitor.js';
import type { HelixApi } from './twitch/helixApi.js';
import type { TokenCipher } from './crypto/tokenCipher.js';
import type { ChannelRecord } from './db/repositories/channelRepository.js';
import { BotIdentityRepository } from './db/repositories/botIdentityRepository.js';
import { CommandRepository } from './db/repositories/commandRepository.js';
import { EmoteRepository } from './db/repositories/emoteRepository.js';
import { ChannelSettingsRepository } from './db/repositories/channelSettingsRepository.js';
import { ChannelRoleRepository } from './db/repositories/channelRoleRepository.js';
import { QuoteRepository } from './db/repositories/quoteRepository.js';
import { CommandManager } from './domain/commandManager.js';
import { EmoteManager } from './domain/emoteManager.js';
import { SettingsService } from './domain/settings.js';
import { ChatPipeline } from './session/chatPipeline.js';
import { ChannelSession } from './session/channelSession.js';
import type { SessionManager } from './session/sessionManager.js';

/**
 * How a row in `channels` becomes a running tenant.
 *
 * Every dependency below is constructed *per channel*. That repetition is the
 * point: there is no shared mutable object for one channel to reach another
 * through, so isolation survives a careless edit rather than depending on one.
 */

export interface BotIdentity {
    twitchUserId: string;
    login: string;
    aiTriggers: string[];
}

/** The four channel-scoped repositories a session needs. */
export interface ChannelRepositories {
    commands: CommandRepository;
    history?: ChatHistoryRepository;
    emotes: EmoteRepository;
    settings: ChannelSettingsRepository;
    roles: ChannelRoleRepository;
    quotes: QuoteRepository;
}

export function createChannelRepositories(db: Database, channelId: string): ChannelRepositories {
    // Bound to this channel at construction, so they cannot read another's rows.
    return {
        commands: new CommandRepository(db, channelId),
        emotes: new EmoteRepository(db, channelId),
        settings: new ChannelSettingsRepository(db, channelId),
        roles: new ChannelRoleRepository(db, channelId),
        quotes: new QuoteRepository(db, channelId),
        history: new ChatHistoryRepository(db, channelId)
    };
}

export interface ChannelDependencies {
    /**
     * Builds the data layer for one channel.
     *
     * A factory rather than a `Database`, so the composition root can be wired
     * and tested end to end without a Postgres. The repositories themselves are
     * exercised against a real one in repositories.test.ts — this seam moves the
     * database out of the wiring test, it does not replace those.
     */
    repositories: (channelId: string) => ChannelRepositories;
    cache: CacheManager;
    logger: Logger;
    chatSink: ChatSink;
    ai: AiService;
    analytics: AnalyticsSink;
    bot: BotIdentity;
    handlers?: HandlerRegistry;
    /** Realtime fan-out. Omitted means nothing is watching. */
    bus?: EventBus;
    /**
     * The Claude client, shared across channels — the API key is a server
     * secret, so there is exactly one. Per-channel state (limits, history,
     * settings) is built around it below.
     */
    claude?: ClaudeClient;
    /** Database handle, needed to build the per-channel AI rate limiter. */
    db?: import('./db/client.js').Database;
    /** Live Helix. Absent means redemption settlement and reward toggles are inert. */
    helix?: HelixApi;
    /** Twitch application credentials, for broadcaster token refresh. */
    twitchOAuth?: { clientId: string; clientSecret: string };
    /** Spotify application credentials, for the per-channel connect. */
    spotifyOAuth?: SpotifyOAuthConfig;
    cipher?: TokenCipher;
    /** AI_COUNTER_THRESHOLD — how few requests left before the viewer is told. */
    counterThreshold?: number;
    /** IMAGE_SEED_SALT — bumping it resets every fursona/waifu association. */
    imageSeedSalt?: string;
}

export function buildChannelSession(deps: ChannelDependencies, channel: ChannelRecord): ChannelSession {
    const { cache, logger, chatSink, analytics, bot, handlers } = deps;
    const ai_fallback = deps.ai;
    const channelId = channel.id;
    const repositories = deps.repositories(channelId);

    const channelLogger = logger.child({ channelId, login: channel.twitchLogin });

    const settings = new SettingsService({
        channelId,
        repository: repositories.settings,
        cache,
        logger: channelLogger
    });

    /*
     * The Spotify half, per channel.
     *
     * Built only when the deployment has Spotify credentials AND the channel
     * has connected: a channel with no Spotify gets null, and every song path
     * reports "not connected" rather than failing obscurely.
     */
    const songQueue = deps.db ? new SongQueueRepository(deps.db, channelId) : null;

    /*
     * Stream lifecycle. Needs only a database: metadata comes from Helix where
     * available, but a channel without Helix still records its streams, which
     * is what the AI rate-limit bucket and !uptime actually depend on.
     */
    const streams = deps.db
        ? new StreamService({
            channelId,
            broadcasterTwitchId: channel.twitchBroadcasterId,
            streams: new StreamRepository(deps.db, channelId),
            logger: channelLogger,
            ...(deps.helix ? { helix: deps.helix } : {})
        })
        : null;

    let spotify: SpotifyClient | null = null;
    if (deps.db && deps.cipher && deps.spotifyOAuth) {
        const spotifyTokens = new SpotifyTokenProvider({
            config: deps.spotifyOAuth,
            channelId,
            repository: new ChannelTokenRepository(deps.db, channelId, deps.cipher),
            logger: channelLogger
        });

        spotify = new HttpSpotifyClient({
            accessToken: () => spotifyTokens.get(),
            logger: channelLogger
        });
    }

    const monitor = (spotify && songQueue)
        ? new PlaybackMonitor({ channelId, client: spotify, queue: songQueue, logger: channelLogger })
        : null;

    /*
     * Redemptions. Settlement needs the BROADCASTER's user token, so this only
     * exists where the credentials to obtain one do - and a channel without it
     * leaves redemptions unhandled rather than taking points it cannot refund.
     */
    let redemptions: RedemptionPipeline | undefined;
    let songToggle: SongToggleService | null = null;
    // Hoisted: presence polling needs the same broadcaster token, and building
    // a second provider would mean two independent refresh paths racing to
    // rotate one refresh token.
    let userTokens: UserTokenProvider | null = null;

    if (deps.db && deps.cipher && deps.helix && deps.twitchOAuth && songQueue) {
        userTokens = new UserTokenProvider({
            clientId: deps.twitchOAuth.clientId,
            clientSecret: deps.twitchOAuth.clientSecret,
            channelId,
            repository: new ChannelTokenRepository(deps.db, channelId, deps.cipher),
            logger: channelLogger
        });

        const rewardRepo = new ChannelRewardRepository(deps.db, channelId);

        songToggle = new SongToggleService({
            channelId,
            broadcasterTwitchId: channel.twitchBroadcasterId,
            settings,
            rewards: rewardRepo,
            helix: deps.helix,
            userTokens,
            logger: channelLogger
        });

        const songDeps = {
            spotify: spotify as SpotifyClient,
            queue: songQueue,
            settings,
            logger: channelLogger,
            playlist: new PlaylistRepository(deps.db, channelId)
        };

        redemptions = new RedemptionPipeline({
            channelId,
            rewards: rewardRepo,
            settlement: new RedemptionSettlement({
                channelId,
                broadcasterTwitchId: channel.twitchBroadcasterId,
                helix: deps.helix,
                userTokens,
                logger: channelLogger
            }),
            handlers: {
                add_quote: createQuoteRedemptionHandler({ quotes: repositories.quotes, logger: channelLogger }),
                // Song handlers only where Spotify is connected; without it the
                // pipeline refunds rather than pretending to queue.
                ...(spotify ? {
                    song_request: createSongRequestHandler(songDeps),
                    skip_queue: createSkipQueueHandler(songDeps)
                } : {})
            },
            logger: channelLogger,
            sendMessage: async (text: string) => {
                await chatSink.send({ channelId, broadcasterTwitchId: channel.twitchBroadcasterId, text });
            }
        });
    }

    /*
     * The real AI when a client and a database are available, the injected stub
     * otherwise. Everything per-channel - the budget, the history, the settings -
     * is constructed here around the single shared client, which is what keeps
     * one channel's usage from touching another's.
     */
    const ai = (deps.claude && deps.db)
        ? new ChannelAiService({
            channelId,
            client: deps.claude,
            settings,
            history: new ChatHistoryRepository(deps.db, channelId),
            rateLimiter: new AiRateLimiter({ db: deps.db, channelId }),
            logger: channelLogger,
            // The P1-WP4.1 flag, closed: buckets are per stream and the
            // prompt carries the real title and category.
            currentStreamId: () => streams?.currentStreamId() ?? null,
            streamContext: () => streams?.context() ?? null,
            broadcasterLogin: channel.twitchLogin,
            ...(deps.counterThreshold === undefined ? {} : { counterThreshold: deps.counterThreshold })
        })
        : ai_fallback;

    /*
     * Presence polling. Needs everything the redemption path needs (a
     * broadcaster user token) plus a stream to attach sessions to.
     */
    const presence = (streams && userTokens && deps.helix && deps.db)
        ? new PresenceTracker({
            channelId,
            broadcasterTwitchId: channel.twitchBroadcasterId,
            streams,
            streamRepository: new StreamRepository(deps.db, channelId),
            roles: repositories.roles,
            helix: deps.helix,
            userToken: () => (userTokens as UserTokenProvider).get(),
            logger: channelLogger
        })
        : null;

    /*
     * A holder rather than the manager itself: `!command` edits the very
     * registry it is registered in, so the CommandManager cannot exist yet when
     * its handlers are built. Filled in immediately after construction, and
     * read only from inside a handler.
     */
    const managerRef: { current: CommandManager | null } = { current: null };

    const commands = new CommandManager({
        channelId,
        repository: repositories.commands,
        cache,
        logger: channelLogger,
        // The AI toggle is always available; a channel-specific registry adds
        // to it rather than replacing it.
        handlers: {
            ...createAiHandlers({ settings, logger: channelLogger }),
            ...(songToggle && songQueue
                ? createSongHandlers({
                    queue: songQueue,
                    spotify,
                    toggle: songToggle,
                    logger: channelLogger,
                    lastPlayed: () => monitor?.lastPlayed() ?? null
                })
                : {}),
            ...(streams
                ? createStreamHandlers({ streams, broadcasterLogin: channel.twitchLogin })
                : {}),
            ...createGameHandlers({ ai, roles: repositories.roles, logger: channelLogger }),
            ...(deps.db
                ? createStatsHandlers({
                    analytics: new AnalyticsRepository(deps.db, channelId),
                    roles: repositories.roles
                })
                : {}),
            // No database and no network: these only need a username.
            ...createThirdPartyHandlers(deps.imageSeedSalt === undefined ? {} : { salt: deps.imageSeedSalt }),
            ...createQuoteHandlers({
                quotes: new QuoteManager({ repository: repositories.quotes }),
                commands: () => managerRef.current as CommandManager,
                logger: channelLogger
            }),
            ...(handlers ?? {})
        }
    });
    managerRef.current = commands;

    const emotes = new EmoteManager({ channelId, repository: repositories.emotes, cache });


    /*
     * Real totals where there is a database, the injected sink otherwise. The
     * analytics API already reads chat_totals, so wiring this is what turns its
     * numbers from structurally-correct zeroes into the channel's real history.
     */
    const analyticsSink = deps.db
        ? new DatabaseAnalyticsSink({
            analytics: new AnalyticsRepository(deps.db, channelId),
            streams: new StreamRepository(deps.db, channelId),
            currentStreamId: () => streams?.currentStreamId() ?? null
        })
        : analytics;

    const pipeline = new ChatPipeline({
        channelId,
        botTwitchUserId: bot.twitchUserId,
        aiTriggers: bot.aiTriggers,
        commands,
        emotes,
        settings,
        roles: repositories.roles,
        ai,
        analytics: analyticsSink,
        logger: channelLogger,
        // Messages land against the stream they happened in.
        currentStreamId: () => streams?.currentStreamId() ?? null,
        ...(repositories.history ? { history: repositories.history } : {}),
        ...(deps.bus ? { bus: deps.bus } : {}),
        // The pipeline knows only "say this"; where it goes is the sink's problem.
        sendMessage: async (text: string) => {
            await chatSink.send({
                channelId,
                broadcasterTwitchId: channel.twitchBroadcasterId,
                text
            });
        }
    });

    return new ChannelSession({
        channelId,
        broadcasterTwitchId: channel.twitchBroadcasterId,
        logger: channelLogger,
        pipeline,
        commands,
        emotes,
        ...(redemptions ? { redemptions } : {}),
        // The session owns the monitor's lifetime: started on start, stopped on
        // stop. Building one and never handing it over is exactly the bug that
        // left a queued track untouched through ninety minutes of playback.
        ...(monitor ? { monitor } : {}),
        ...(streams ? { streams } : {}),
        ...(presence ? { presence } : {})
    });
}

/**
 * Brings up every active channel.
 *
 * One channel failing to start must not stop the others: a single bad row would
 * otherwise take the whole service down for every tenant.
 */
export async function bootstrapChannels(
    deps: ChannelDependencies,
    manager: SessionManager,
    channels: ChannelRecord[]
): Promise<{ started: number; failed: number }> {
    let started = 0;
    let failed = 0;

    for (const channel of channels) {
        try {
            await manager.add(buildChannelSession(deps, channel));
            started++;
        } catch (err) {
            failed++;
            deps.logger.error(
                { channelId: channel.id, login: channel.twitchLogin, err: (err as Error).message },
                'Failed to start channel - continuing with the rest'
            );
        }
    }

    deps.logger.info({ started, failed, total: channels.length }, 'Channel bootstrap complete');
    return { started, failed };
}

/**
 * Resolves the shared bot account.
 *
 * The database is the source of truth; env is the escape hatch for a deployment
 * that has not been through onboarding yet. Neither present is not fatal — the
 * bot simply cannot recognise its own messages — but it is worth a warning,
 * because the symptom (a bot answering itself) reads as a logic bug.
 */
export async function resolveBotIdentity(db: Database, env: Env, logger: Logger): Promise<BotIdentity> {
    const stored = await new BotIdentityRepository(db).get().catch((err: unknown) => {
        logger.warn({ err: (err as Error).message }, 'Could not read bot_identity');
        return null;
    });

    const twitchUserId = stored?.twitchUserId ?? env.BOT_TWITCH_USER_ID ?? '';
    const login = stored?.twitchLogin ?? 'almosthadai';

    if (twitchUserId === '') {
        logger.warn(
            'No bot identity configured (bot_identity is empty and BOT_TWITCH_USER_ID is unset) - ' +
            'the bot cannot recognise its own messages'
        );
    }

    const aiTriggers = env.AI_TRIGGERS
        ? env.AI_TRIGGERS.split(',').map((t) => t.trim().toLowerCase()).filter((t) => t !== '')
        : [login.toLowerCase()];

    return { twitchUserId, login, aiTriggers };
}
