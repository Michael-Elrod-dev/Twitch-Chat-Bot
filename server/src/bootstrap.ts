import type { Env } from './config/env.js';
import type { Logger } from './logger.js';
import type { Database } from './db/client.js';
import type { CacheManager } from './cache/cacheManager.js';
import type { ChatSink } from './services/chatSink.js';
import type { AiService } from './services/aiService.js';
import type { AnalyticsSink } from './services/analytics.js';
import type { HandlerRegistry } from './domain/handlers.js';
import type { EventBus } from './live/eventBus.js';
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
        quotes: new QuoteRepository(db, channelId)
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
}

export function buildChannelSession(deps: ChannelDependencies, channel: ChannelRecord): ChannelSession {
    const { cache, logger, chatSink, ai, analytics, bot, handlers } = deps;
    const channelId = channel.id;
    const repositories = deps.repositories(channelId);

    const channelLogger = logger.child({ channelId, login: channel.twitchLogin });

    const commands = new CommandManager({
        channelId,
        repository: repositories.commands,
        cache,
        logger: channelLogger,
        ...(handlers ? { handlers } : {})
    });
    const emotes = new EmoteManager({ channelId, repository: repositories.emotes, cache });
    const settings = new SettingsService({
        channelId,
        repository: repositories.settings,
        cache,
        logger: channelLogger
    });

    const pipeline = new ChatPipeline({
        channelId,
        botTwitchUserId: bot.twitchUserId,
        aiTriggers: bot.aiTriggers,
        commands,
        emotes,
        settings,
        roles: repositories.roles,
        ai,
        analytics,
        logger: channelLogger,
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
        emotes
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
