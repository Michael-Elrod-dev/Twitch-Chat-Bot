import { createServer } from 'node:http';
import { loadEnv, ConfigError } from './config/env.js';
import { createLogger } from './logger.js';
import { createApp } from './http/app.js';
import { createShutdownHandler, installSignalHandlers } from './lifecycle.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createRedis } from './cache/redis.js';
import { CacheManager } from './cache/cacheManager.js';
import { ChannelRepository } from './db/repositories/channelRepository.js';
import { SessionManager } from './session/sessionManager.js';
import { EventSubWebhookTransport } from './transport/eventsub/webhookTransport.js';
import { EVENTSUB_WEBHOOK_PATH } from './transport/eventsub/webhook.js';
import { SubscriptionReconciler } from './transport/eventsub/subscriptionReconciler.js';
import { FakeHelixClient } from './transport/eventsub/helixClient.js';
import { LoggingChatSink } from './services/chatSink.js';
import { StubAiService } from './services/aiService.js';
import { NoopAnalyticsSink } from './services/analytics.js';
import {
    bootstrapChannels,
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
 *   config -> logger -> postgres (+migrations) -> redis -> transport ->
 *   sessions -> HTTP.
 * HTTP is last on purpose: the port opens only once the server can actually
 * serve, so a health check cannot pass on a half-built process.
 */
async function main(): Promise<void> {
    let env;
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
    try {
        await runMigrations(database);
        logger.info('Database migrations applied');
    } catch (err) {
        logger.fatal({ err }, 'Database migration failed');
        await database.close();
        process.exit(1);
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

    const chatSink = new LoggingChatSink(logger);

    const callbackUrl = `${env.PUBLIC_URL ?? `http://localhost:${env.PORT}`}${EVENTSUB_WEBHOOK_PATH}`;
    const botIdentity = await resolveBotIdentity(database.db, env, logger);

    // The reconciler runs against a fake client in dry-run until P1-WP6 supplies
    // an app access token. The diff is computed and logged from day one, so the
    // day it goes live it executes a plan that has already been watched.
    const reconciler = new SubscriptionReconciler({
        client: new FakeHelixClient(),
        logger,
        callbackUrl,
        secret: env.TWITCH_EVENTSUB_SECRET,
        botUserId: botIdentity.twitchUserId
    });

    const channelRepository = new ChannelRepository(database.db);

    const transport = new EventSubWebhookTransport({
        secret: env.TWITCH_EVENTSUB_SECRET,
        logger,
        maxSkewMs: env.EVENTSUB_MAX_SKEW_SECONDS * 1_000,
        reconciler,
        dryRunSubscriptions: true,
        onRevocation: (subscription) => {
            // Fire-and-forget: the webhook has already answered Twitch, and the
            // bookkeeping must not be able to delay that.
            void markChannelDisconnected(subscription.condition['broadcaster_user_id']);
        }
    });

    async function markChannelDisconnected(broadcasterTwitchId: string | undefined): Promise<void> {
        if (!broadcasterTwitchId) return;
        try {
            const channel = await channelRepository.findByBroadcasterId(broadcasterTwitchId);
            if (!channel) return;
            await channelRepository.setStatus(channel.id, 'disconnected');
            logger.error(
                { channelId: channel.id, login: channel.twitchLogin },
                'Channel marked disconnected after subscription revocation'
            );
        } catch (err) {
            logger.error({ broadcasterTwitchId, err: (err as Error).message }, 'Could not mark channel disconnected');
        }
    }

    const sessionManager = new SessionManager({ transport, logger });
    await sessionManager.start();

    const dependencies: ChannelDependencies = {
        repositories: (channelId) => createChannelRepositories(database.db, channelId),
        cache,
        logger,
        chatSink,
        ai: new StubAiService(),
        analytics: new NoopAnalyticsSink(),
        bot: botIdentity
    };

    // One reconciliation after every channel is registered, rather than one per
    // channel inside the bootstrap loop.
    transport.setAutoReconcile(false);
    const active = await channelRepository.listActive();
    await bootstrapChannels(dependencies, sessionManager, active);
    transport.setAutoReconcile(true);
    await transport.reconcile();

    const app = createApp({
        logger,
        version: VERSION,
        rawBodyRouters: [transport.router],
        probes: [
            { name: 'postgres', check: database.ping },
            { name: 'redis', check: redis.ping }
        ]
    });
    const server = createServer(app);

    const shutdown = createShutdownHandler({
        server,
        logger,
        // Order matters. The HTTP server closes first (handled inside), so no new
        // deliveries arrive; then the queue drains what was already acknowledged
        // — dropping those would lose events Twitch believes were accepted;
        // then sessions stop; then the connections they used close.
        closeables: [
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
                webhook: callbackUrl
            },
            'Server listening'
        );
    });
}

void main();
