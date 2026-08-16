import { createServer } from 'node:http';
import { Router } from 'express';
import { loadEnv, ConfigError, type Env } from './config/env.js';
import { createLogger, type Logger } from './logger.js';
import { createApp } from './http/app.js';
import { createShutdownHandler, installSignalHandlers } from './lifecycle.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createRedis } from './cache/redis.js';
import { CacheManager } from './cache/cacheManager.js';
import { ChannelRepository } from './db/repositories/channelRepository.js';
import { AppSessionRepository } from './db/repositories/appSessionRepository.js';
import { SessionManager } from './session/sessionManager.js';
import { EventSubWebhookTransport } from './transport/eventsub/webhookTransport.js';
import { EVENTSUB_WEBHOOK_PATH } from './transport/eventsub/webhook.js';
import { SubscriptionReconciler } from './transport/eventsub/subscriptionReconciler.js';
import { FakeHelixClient, type HelixClient } from './transport/eventsub/helixClient.js';
import { RevocationRecovery } from './transport/eventsub/revocationRecovery.js';
import { LoggingChatSink, type ChatSink } from './services/chatSink.js';
import { HelixChatSink } from './services/helixChatSink.js';
import { StubAiService } from './services/aiService.js';
import { NoopAnalyticsSink } from './services/analytics.js';
import { HelixApi } from './twitch/helixApi.js';
import { AppTokenProvider } from './twitch/appTokenProvider.js';
import { TwitchOAuthClient, buildAuthorizeUrl } from './twitch/oauth.js';
import { createTokenCipher, createDisabledTokenCipher, type TokenCipher } from './crypto/tokenCipher.js';
import { createStateStore } from './auth/stateStore.js';
import { OnboardingService } from './auth/onboarding.js';
import { createAuthRouter, AUTH_CALLBACK_PATH } from './http/authRoutes.js';
import { createResourceRouter } from './http/api/resources.js';
import {
    createRequireJwt,
    createApiKeyAuth,
    createRequireChannelExceptMe,
    requireAnyCredential
} from './http/api/middleware.js';
import { createRateLimit } from './http/api/rateLimit.js';
import { ApiKeyRepository } from './db/repositories/apiKeyRepository.js';
import { AnalyticsRepository } from './db/repositories/analyticsRepository.js';
import { SongQueueRepository } from './db/repositories/songQueueRepository.js';
import { createEventBus } from './live/eventBus.js';
import { LiveServer } from './live/liveServer.js';
import {
    bootstrapChannels,
    buildChannelSession,
    createChannelRepositories,
    resolveBotIdentity,
    type ChannelDependencies
} from './bootstrap.js';

const VERSION = process.env['npm_package_version'] ?? '0.1.0';

/**
 * The composition root.
 *
 * This is the only file allowed to know how everything fits together. Every
 * module below is written against interfaces and constructed here, which is what
 * makes the rest of the server testable without a database, a Redis, or Twitch.
 *
 * Boot order is a dependency order, not a preference:
 *   config -> logger -> postgres (+migrations) -> redis -> twitch -> transport ->
 *   sessions -> HTTP.
 * HTTP is last on purpose: the port opens only once the server can actually
 * serve, so a health check cannot pass on a half-built process.
 */
async function main(): Promise<void> {
    // Annotated because a nested function closes over it, so inference alone
    // cannot settle the type before use.
    let env: Env;
    try {
        env = loadEnv();
    } catch (error) {
        if (error instanceof ConfigError) {
            // Before the logger exists, so this is the one legitimate console use.
            console.error(error.message);
            process.exit(78); // EX_CONFIG
        }
        throw error;
    }

    const logger = createLogger(env);

    const database = createDb(env);

    // Migrations run at boot: the schema a deployment gets is the schema its code
    // was built against, with no separate "did you remember to migrate" step.
    //
    // On separate credentials when configured, because ALTER TABLE needs table
    // ownership and the runtime role deliberately does not have it. The
    // connection is opened for the migration and closed immediately, so the
    // privileged credentials are not held open for the process's lifetime.
    const migrationHandle = env.MIGRATION_DATABASE_URL
        ? createDb({ DATABASE_URL: env.MIGRATION_DATABASE_URL, DATABASE_POOL_MAX: 2 })
        : database;

    try {
        await runMigrations(migrationHandle);
        logger.info(
            { role: env.MIGRATION_DATABASE_URL ? 'migration' : 'runtime' },
            'Database migrations applied'
        );
    } catch (err) {
        logger.fatal({ err }, 'Database migration failed');
        if (migrationHandle !== database) await migrationHandle.close();
        await database.close();
        process.exit(1);
    } finally {
        if (migrationHandle !== database) await migrationHandle.close();
    }

    // Redis is a cache, never a source of truth, so a Redis that is down at boot
    // is a degradation and not a failure. /readyz still reports it.
    const redis = createRedis({ url: env.REDIS_URL, logger });
    try {
        await redis.client.connect();
    } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Redis unavailable at boot - running in fallback mode');
    }
    const cache = new CacheManager(redis, logger);

    // Without a key the cipher refuses every operation rather than passing values
    // through: a server that cannot encrypt must be unable to store a credential
    // at all. Production never reaches here without one - loadEnv refuses first.
    const cipher: TokenCipher = env.TOKEN_ENCRYPTION_KEY
        ? createTokenCipher(env.TOKEN_ENCRYPTION_KEY)
        : (logger.warn('TOKEN_ENCRYPTION_KEY is not set - token storage is disabled'), createDisabledTokenCipher());

    const publicUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;
    const callbackUrl = `${publicUrl}${EVENTSUB_WEBHOOK_PATH}`;
    const redirectUri = `${publicUrl}${AUTH_CALLBACK_PATH}`;

    const twitchConfigured = Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
    if (!twitchConfigured) {
        logger.warn('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set - OAuth and live Helix calls are unavailable');
    }

    // Mutable on purpose: bot consent can be re-granted while the process runs,
    // and everything downstream reads through this rather than copying it.
    let botIdentity = await resolveBotIdentity(database.db, env, logger);

    // Real Helix when credentials exist, the in-memory fake otherwise. The
    // reconciler cannot tell the difference, which is what let the whole
    // subscription model be built and tested before any of this was live.
    const appTokens = twitchConfigured
        ? new AppTokenProvider({
            clientId: env.TWITCH_CLIENT_ID as string,
            clientSecret: env.TWITCH_CLIENT_SECRET as string,
            logger
        })
        : null;

    const helix = appTokens
        ? new HelixApi({
            clientId: env.TWITCH_CLIENT_ID as string,
            appTokens,
            logger,
            createSpacingMs: env.EVENTSUB_CREATE_SPACING_MS
        })
        : null;

    const helixClient: HelixClient = helix ?? new FakeHelixClient();

    const reconciler = new SubscriptionReconciler({
        client: helixClient,
        logger,
        callbackUrl,
        secret: env.TWITCH_EVENTSUB_SECRET,
        botUserId: () => botIdentity.twitchUserId
    });

    const channelRepository = new ChannelRepository(database.db);

    // Live mode is opt-in and additionally requires a real client: EVENTSUB_DRY_RUN=false
    // with no credentials would otherwise "reconcile" the in-memory fake and
    // report success while changing nothing at Twitch.
    const dryRunSubscriptions = env.EVENTSUB_DRY_RUN || !helix;
    if (!env.EVENTSUB_DRY_RUN && !helix) {
        logger.error('EVENTSUB_DRY_RUN=false but Twitch credentials are missing - staying in dry-run');
    }

    const revocationRecovery = new RevocationRecovery({
        logger,
        channels: channelRepository,
        reconciler,
        activeBroadcasterIds: () => transport.subscribedBroadcasters
    });

    const transport = new EventSubWebhookTransport({
        secret: env.TWITCH_EVENTSUB_SECRET,
        logger,
        maxSkewMs: env.EVENTSUB_MAX_SKEW_SECONDS * 1_000,
        reconciler,
        dryRunSubscriptions,
        // Returns immediately: the webhook has already answered Twitch and the
        // recovery must not be able to delay that.
        onRevocation: (subscription) => revocationRecovery.handle(subscription)
    });

    const sessionManager = new SessionManager({ transport, logger });
    await sessionManager.start();

    // The real sink the moment a bot identity and credentials exist; the logging
    // one otherwise, so the pipeline is exercised either way.
    // Chosen on whether a real Helix client exists, NOT on whether a bot identity
    // does - consent can arrive later, and the sink reads the id per send.
    const chatSink: ChatSink = helix
        ? new HelixChatSink({ helix, botUserId: () => botIdentity.twitchUserId, logger })
        : new LoggingChatSink(logger);

    // One bus for the whole process; the live server filters by channel on the
    // way out, so a session never needs to know whether anyone is watching.
    const bus = createEventBus((err) => logger.warn({ err: err.message }, 'Live listener failed'));

    const buildDependencies = (): ChannelDependencies => ({
        repositories: (channelId) => createChannelRepositories(database.db, channelId),
        cache,
        logger,
        chatSink,
        ai: new StubAiService(),
        analytics: new NoopAnalyticsSink(),
        bot: botIdentity,
        bus
    });

    // One reconciliation after every channel is registered, rather than one per
    // channel inside the bootstrap loop.
    transport.setAutoReconcile(false);
    const active = await channelRepository.listActive();
    await bootstrapChannels(buildDependencies(), sessionManager, active);
    transport.setAutoReconcile(true);
    await transport.reconcile();

    const oauth = new TwitchOAuthClient({
        config: {
            clientId: env.TWITCH_CLIENT_ID ?? '',
            clientSecret: env.TWITCH_CLIENT_SECRET ?? '',
            redirectUri
        },
        logger
    });

    /**
     * Applies a newly-granted bot consent without a restart.
     *
     * The reconciler and the chat sink read the identity through getters, so
     * they need nothing. Sessions do: each pipeline captured the bot's user id
     * at construction for its own-message check, and a session still holding the
     * old id would let the bot answer itself. Rebuilding them is cheap and this
     * happens roughly once per deployment.
     */
    async function applyNewBotIdentity(): Promise<void> {
        const previous = botIdentity.twitchUserId;
        botIdentity = await resolveBotIdentity(database.db, env, logger);

        if (botIdentity.twitchUserId === previous) return;

        logger.warn(
            { login: botIdentity.login, channels: sessionManager.size },
            'Bot identity changed - rebuilding sessions'
        );

        // Removed and re-added individually rather than via stopAll(), which
        // would also stop the transport and close the ingest queue.
        const deps = buildDependencies();
        for (const channel of await channelRepository.listActive()) {
            try {
                await sessionManager.remove(channel.id);
                await sessionManager.add(buildChannelSession(deps, channel));
            } catch (err) {
                logger.error(
                    { channelId: channel.id, err: (err as Error).message },
                    'Could not rebuild session for the new bot identity'
                );
            }
        }

        await transport.reconcile();
        logger.info({ login: botIdentity.login }, 'New bot identity applied');
    }

    const authRouter = createAuthRouter({
        oauth,
        states: createStateStore(cache),
        onboarding: new OnboardingService({
            db: database.db,
            cipher,
            logger,
            sessionManager,
            dependencies: buildDependencies,
            reconcile: () => transport.reconcile(),
            onBotIdentityChanged: applyNewBotIdentity
        }),
        sessions: new AppSessionRepository(database.db),
        logger,
        jwtSecret: env.JWT_SECRET,
        jwtTtlSeconds: env.JWT_TTL_SECONDS,
        configured: twitchConfigured
    });

    // The v1 API. Order is the security contract: credentials resolve first,
    // then the tenant, then the rate limit, then the handlers. A handler is
    // never reached without a channel already bound to the request.
    const apiKeyRepository = new ApiKeyRepository(database.db);

    const apiRouter = Router();
    apiRouter.use('/api/v1', createApiKeyAuth(apiKeyRepository, channelRepository));
    apiRouter.use('/api/v1', (req, res, next) => {
        // /me is reachable without a channel; everything else is not. Running
        // JWT auth here keeps the two paths on one middleware chain.
        createRequireJwt(env.JWT_SECRET, logger)(req, res, (err?: unknown) => {
            if (err) { next(err); return; }
            next();
        });
    });
    apiRouter.use('/api/v1', requireAnyCredential);
    apiRouter.use('/api/v1', createRateLimit({
        windowMs: env.API_RATE_WINDOW_MS,
        max: env.API_RATE_MAX,
        bucket: 'api'
    }));
    apiRouter.use(createRequireChannelExceptMe(channelRepository));
    apiRouter.use(createResourceRouter({
        logger,
        repositories: (channelId) => createChannelRepositories(database.db, channelId),
        apiKeys: apiKeyRepository,
        analytics: (channelId) => new AnalyticsRepository(database.db, channelId),
        songs: (channelId) => new SongQueueRepository(database.db, channelId),
        publish: (channelId, event) => bus.publish(channelId, {
            ...event, channelId, at: new Date().toISOString()
        } as never)
    }));

    const app = createApp({
        logger,
        version: VERSION,
        rawBodyRouters: [transport.router],
        routers: [authRouter, apiRouter],
        probes: [
            { name: 'postgres', check: database.ping },
            { name: 'redis', check: redis.ping }
        ]
    });
    const server = createServer(app);

    const live = new LiveServer({
        server,
        bus,
        channels: channelRepository,
        logger,
        jwtSecret: env.JWT_SECRET
    });

    const shutdown = createShutdownHandler({
        server,
        logger,
        // Order matters. The HTTP server closes first (handled inside), so no new
        // deliveries arrive; then the queue drains what was already acknowledged
        // — dropping those would lose events Twitch believes were accepted;
        // then sessions stop; then the connections they used close.
        closeables: [
            // Sockets first: a client that reconnects during shutdown would
            // otherwise attach to a server that is already tearing down.
            { name: 'live-sockets', close: () => live.close() },
            { name: 'ingest-queue', close: () => transport.drain() },
            { name: 'sessions', close: () => sessionManager.stopAll() },
            { name: 'redis', close: redis.close },
            { name: 'postgres', close: database.close }
        ]
    });
    installSignalHandlers(shutdown, logger);

    server.listen(env.PORT, () => {
        logger.info(
            {
                port: env.PORT,
                nodeEnv: env.NODE_ENV,
                version: VERSION,
                channels: sessionManager.size,
                webhook: callbackUrl,
                eventsubDryRun: dryRunSubscriptions
            },
            'Server listening'
        );

        logOnboardingUrls(env, logger, redirectUri, twitchConfigured);
    });
}

/**
 * The consent links, printed at boot.
 *
 * These are the two URLs the owner has to visit to activate the system, and
 * hunting for them in a README while the server is already running is exactly
 * the kind of friction that makes an activation step get skipped. They contain
 * no secret — a client id is public by design, and the `state` is issued per
 * request by the route itself, not here.
 */
function logOnboardingUrls(env: Env, logger: Logger, redirectUri: string, configured: boolean): void {
    if (!configured) {
        logger.warn('Onboarding URLs unavailable until TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set');
        return;
    }

    const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;

    logger.info(
        {
            botConsent: `${base}/auth/bot/connect`,
            channelConnect: `${base}/auth/twitch/connect`,
            appSignIn: `${base}/auth/app/login`,
            registeredRedirectUri: redirectUri
        },
        'Authorization URLs - the redirect URI must match the Twitch console exactly'
    );

    // Logged so a mismatch between what we send and what the console holds is
    // visible without decoding a redirect by hand.
    logger.debug(
        { example: buildAuthorizeUrl({ clientId: env.TWITCH_CLIENT_ID ?? '', clientSecret: '', redirectUri }, 'bot', 'EXAMPLE_STATE') },
        'Example bot authorize URL (state is issued per request)'
    );
}

void main();
