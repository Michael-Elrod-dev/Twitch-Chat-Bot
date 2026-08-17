import { Router, type Response } from 'express';
import {
    apiFailure,
    apiSuccess,
    createCommandSchema,
    createEmoteSchema,
    createQuoteSchema,
    createApiKeySchema,
    updateCommandSchema,
    updateSettingsSchema,
    setChannelEnabledSchema,
    toggleSongRequestsSchema,
    paginationSchema,
    commandNameSchema,
    emoteTriggerSchema,
    type Command,
    type Emote,
    type Quote,
    type MeResponse,
    type ChannelSettings,
    type ChannelEnabledResponse,
    type DashboardSummary,
    type ApiKeySummary,
    type CreatedApiKey,
    type AnalyticsSummary,
    type QueuedSong,
    type Pagination
} from '@almosthadai/shared';
import type { Logger } from '../../logger.js';
import {
    validateBody,
    validateQuery,
    getValidatedQuery,
    rejectApiKey,
    type ApiRequest
} from './middleware.js';
import type { ChannelRepositories } from '../../bootstrap.js';
import type { ChannelRepository } from '../../db/repositories/channelRepository.js';
import type { ApiKeyRepository } from '../../db/repositories/apiKeyRepository.js';
import type { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import type { DashboardRepository } from '../../db/repositories/dashboardRepository.js';
import type { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';

/**
 * The v1 resources.
 *
 * Every handler reads `req.channel`, which the credential resolved. No handler
 * takes a channel from the request, so none can be pointed at another tenant —
 * the isolation guarantee is structural rather than per-handler diligence.
 */

export interface ResourceOptions {
    logger: Logger;
    repositories: (channelId: string) => ChannelRepositories;
    /** The tenancy root, for the one route that writes to the channel itself. */
    channels: ChannelRepository;
    apiKeys: ApiKeyRepository;
    analytics: (channelId: string) => AnalyticsRepository;
    dashboard: (channelId: string) => DashboardRepository;
    songs: (channelId: string) => SongQueueRepository;
    /** Notifies live sockets. Optional so tests can omit it. */
    publish?: (channelId: string, event: { type: string }) => void;
    /**
     * Whether a channel has Spotify linked.
     *
     * A seam rather than a repository, because the token repository needs the
     * cipher and this router has no business holding one — the question is
     * "is there a row", and answering it should not put the key to every stored
     * credential within reach of a route handler. Optional, and absent means
     * "not connected": a build wired without it under-reports a tile rather
     * than claiming a connection that may not exist.
     */
    spotifyConnected?: (channelId: string) => Promise<boolean>;
    /**
     * Starts or stops the channel's session to match the switch.
     *
     * A seam rather than a `SessionManager` dependency: the route's job is to
     * record the owner's choice and then ask the running server to honour it,
     * and the composition root is the only place that knows how a session is
     * built. Optional so route tests can observe the call without booting one.
     */
    applyChannelEnabled?: (channelId: string, enabled: boolean) => Promise<void>;
    /**
     * Tells the running session that its commands or emotes changed.
     *
     * A seam for the same reason `applyChannelEnabled` is one: the route's job
     * is to record the change, and the composition root is the only place that
     * knows a session exists. Without it the write lands in the database and
     * the bot never learns — the managers hold an in-memory map and a populated
     * cache, and a row inserted behind them stays invisible until restart.
     *
     * **Required, unlike the other seams here, and deliberately so.** This is
     * the shape of the defect that shipped: not a wiring somebody deleted, but
     * a connection nobody had made, which no type complained about. Optional
     * would mean a build that forgets it compiles cleanly and saves commands
     * that never fire — the exact failure, silently available again. Required
     * makes forgetting it a compile error at the composition root, which is the
     * only place that can get it wrong.
     */
    reloadChannelContent: (channelId: string, kind: 'commands' | 'emotes') => Promise<void>;
}

/** Wraps an async handler so a rejection becomes a 500 envelope, not a hang. */
const handle = (
    logger: Logger,
    fn: (req: ApiRequest, res: Response) => Promise<void>
) => (req: ApiRequest, res: Response): void => {
    void fn(req, res).catch((err: unknown) => {
        logger.error({ err: (err as Error).message, path: req.path }, 'API handler failed');
        if (!res.headersSent) res.status(500).json(apiFailure('internal', 'Request failed'));
    });
};

export function createResourceRouter(options: ResourceOptions): Router {
    const { logger, repositories, apiKeys, analytics, dashboard, songs } = options;
    const router = Router();
    const ok = handle.bind(null, logger);

    // ---- me + settings -----------------------------------------------------

    router.get('/api/v1/me', rejectApiKey, ok(async (req, res) => {
        const claims = req.claims;
        const channel = req.channel;
        if (!claims) {
            res.status(401).json(apiFailure('unauthorized', 'Token is not valid'));
            return;
        }

        // `me` is the one route that tolerates having no channel: being signed
        // in without one is an ordinary state the client must be able to render.
        const settings = channel ? await repositories(channel.id).settings.get() : null;
        const spotify = channel ? await (options.spotifyConnected?.(channel.id) ?? false) : false;

        const body: MeResponse = {
            twitchUserId: claims.sub,
            login: claims.login,
            channel: channel
                ? {
                    id: channel.id,
                    login: channel.twitchLogin,
                    displayName: null,
                    status: channel.status,
                    enabled: channel.enabled
                }
                : null,
            settings: settings
                ? {
                    aiEnabled: settings.aiEnabled,
                    songRequestsEnabled: settings.songRequestsEnabled,
                    // Reported as a boolean, never as the URL: a webhook URL is
                    // a capability, and echoing it back would let a stolen token
                    // exfiltrate one.
                    discordWebhookConfigured: settings.discordWebhookUrl !== null,
                    // Same rule, same reason: presence, never the credential.
                    spotifyConnected: spotify
                }
                : null
        };

        res.status(200).json(apiSuccess(body));
    }));

    router.patch(
        '/api/v1/me/settings',
        rejectApiKey,
        validateBody(updateSettingsSchema),
        ok(async (req, res) => {
            const channel = req.channel;
            if (!channel) {
                res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
                return;
            }

            await repositories(channel.id).settings.update(req.body);
            const updated = await repositories(channel.id).settings.get();

            // `satisfies` rather than a bare literal: this and `/me` are two
            // places that build the same contract type, and the compiler is
            // what stops them drifting apart when a field is added to one.
            res.status(200).json(apiSuccess({
                aiEnabled: updated?.aiEnabled ?? true,
                songRequestsEnabled: updated?.songRequestsEnabled ?? true,
                discordWebhookConfigured: (updated?.discordWebhookUrl ?? null) !== null,
                spotifyConnected: await (options.spotifyConnected?.(channel.id) ?? false)
            } satisfies ChannelSettings));
        })
    );

    /**
     * The header's bot master switch.
     *
     * `rejectApiKey` like every other management route: a Stream Deck key is
     * scoped to queue/skip/toggle, and one that could switch the whole bot off
     * would be a far worse thing to have taped inside a profile.
     *
     * The write lands before the session is touched, so the owner's choice
     * survives a failure to act on it — a bot recorded off but still running is
     * momentarily wrong and self-corrects at the next boot, whereas a bot
     * recorded on but stopped is silently dead until someone notices.
     */
    router.patch(
        '/api/v1/me/channel',
        rejectApiKey,
        validateBody(setChannelEnabledSchema),
        ok(async (req, res) => {
            const channel = req.channel;
            if (!channel) {
                res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
                return;
            }

            const { enabled } = req.body as { enabled: boolean };
            const updated = await options.channels.setEnabled(channel.id, enabled);
            if (!updated) {
                res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
                return;
            }

            // Only ever this channel's id — the route never reads one from the
            // request, so it cannot reach another tenant's session.
            await options.applyChannelEnabled?.(channel.id, enabled);

            // Both fields, read back from the row rather than assumed: the
            // switch must not have moved `status`, and this is where that is
            // reported rather than hoped for.
            res.status(200).json(apiSuccess({
                enabled: updated.enabled,
                status: updated.status
            } satisfies ChannelEnabledResponse));
        })
    );

    // ---- commands ----------------------------------------------------------

    router.get('/api/v1/commands', rejectApiKey, validateQuery(paginationSchema), ok(async (req, res) => {
        const { limit, offset } = getValidatedQuery<Pagination>(req);
        const all = await repositories(req.channel!.id).commands.listAll();

        res.status(200).json(apiSuccess({
            items: all.slice(offset, offset + limit) as Command[],
            total: all.length,
            limit,
            offset
        }));
    }));

    router.post(
        '/api/v1/commands',
        rejectApiKey,
        validateBody(createCommandSchema),
        ok(async (req, res) => {
            const repo = repositories(req.channel!.id).commands;
            const body = req.body as { name: string; responseText: string; userLevel: Command['userLevel'] };

            if ((await repo.listAll()).some((c) => c.name === body.name)) {
                res.status(409).json(apiFailure('conflict', `${body.name} already exists`));
                return;
            }

            await repo.create({ ...body, handlerName: null });
            // Before responding: the client types the command in chat the second
            // it sees the row appear, so a reload that trailed the response
            // would lose that race for no reason.
            await options.reloadChannelContent(req.channel!.id, 'commands');
            res.status(201).json(apiSuccess({ ...body, handlerName: null } satisfies Command));
        })
    );

    router.patch(
        '/api/v1/commands/:name',
        rejectApiKey,
        validateBody(updateCommandSchema),
        ok(async (req, res) => {
            const parsed = commandNameSchema.safeParse(req.params['name']);
            if (!parsed.success) {
                res.status(400).json(apiFailure('bad_request', 'invalid command name'));
                return;
            }

            const repo = repositories(req.channel!.id).commands;
            const existing = (await repo.listAll()).find((c) => c.name === parsed.data);
            if (!existing) {
                res.status(404).json(apiFailure('not_found', 'No such command'));
                return;
            }

            const body = req.body as { responseText?: string; userLevel?: Command['userLevel'] };
            if (body.responseText !== undefined) await repo.updateResponse(parsed.data, body.responseText);
            if (body.userLevel !== undefined) await repo.updateUserLevel(parsed.data, body.userLevel);

            await options.reloadChannelContent(req.channel!.id, 'commands');

            const updated = (await repo.listAll()).find((c) => c.name === parsed.data);
            res.status(200).json(apiSuccess(updated as Command));
        })
    );

    router.delete('/api/v1/commands/:name', rejectApiKey, ok(async (req, res) => {
        const parsed = commandNameSchema.safeParse(req.params['name']);
        if (!parsed.success) {
            res.status(400).json(apiFailure('bad_request', 'invalid command name'));
            return;
        }

        const deleted = await repositories(req.channel!.id).commands.delete(parsed.data);
        if (!deleted) {
            res.status(404).json(apiFailure('not_found', 'No such command'));
            return;
        }

        // A deleted command must stop answering, which needs the same reload:
        // the cache would otherwise keep serving it until the session restarts.
        await options.reloadChannelContent(req.channel!.id, 'commands');
        res.status(204).end();
    }));

    // ---- emotes ------------------------------------------------------------

    router.get('/api/v1/emotes', rejectApiKey, validateQuery(paginationSchema), ok(async (req, res) => {
        const { limit, offset } = getValidatedQuery<Pagination>(req);
        const all = await repositories(req.channel!.id).emotes.listAll();

        res.status(200).json(apiSuccess({
            items: all.slice(offset, offset + limit) as Emote[],
            total: all.length,
            limit,
            offset
        }));
    }));

    router.post('/api/v1/emotes', rejectApiKey, validateBody(createEmoteSchema), ok(async (req, res) => {
        const repo = repositories(req.channel!.id).emotes;
        const body = req.body as Emote;

        if ((await repo.listAll()).some((e) => e.triggerText === body.triggerText)) {
            res.status(409).json(apiFailure('conflict', `${body.triggerText} already exists`));
            return;
        }

        await repo.create(body);
        await options.reloadChannelContent(req.channel!.id, 'emotes');
        res.status(201).json(apiSuccess(body));
    }));

    router.delete('/api/v1/emotes/:trigger', rejectApiKey, ok(async (req, res) => {
        const trigger = emoteTriggerSchema.parse(req.params['trigger']);
        const deleted = await repositories(req.channel!.id).emotes.delete(trigger);

        if (!deleted) {
            res.status(404).json(apiFailure('not_found', 'No such emote'));
            return;
        }

        await options.reloadChannelContent(req.channel!.id, 'emotes');
        res.status(204).end();
    }));

    // ---- quotes ------------------------------------------------------------

    router.get('/api/v1/quotes', rejectApiKey, validateQuery(paginationSchema), ok(async (req, res) => {
        const { limit, offset } = getValidatedQuery<Pagination>(req);
        const repo = repositories(req.channel!.id).quotes;

        res.status(200).json(apiSuccess({
            items: await repo.list(limit, offset) as Quote[],
            total: await repo.count(),
            limit,
            offset
        }));
    }));

    // Before /:number, or `random` would be parsed as a quote number.
    router.get('/api/v1/quotes/random', rejectApiKey, ok(async (req, res) => {
        const quote = await repositories(req.channel!.id).quotes.getRandom();
        if (!quote) {
            res.status(404).json(apiFailure('not_found', 'This channel has no quotes yet'));
            return;
        }
        res.status(200).json(apiSuccess(quote as Quote));
    }));

    router.get('/api/v1/quotes/:number', rejectApiKey, ok(async (req, res) => {
        const number = Number(req.params['number']);
        if (!Number.isInteger(number) || number < 1) {
            res.status(400).json(apiFailure('bad_request', 'quote number must be a positive integer'));
            return;
        }

        const quote = await repositories(req.channel!.id).quotes.getByNumber(number);
        if (!quote) {
            res.status(404).json(apiFailure('not_found', 'No such quote'));
            return;
        }
        res.status(200).json(apiSuccess(quote as Quote));
    }));

    router.post('/api/v1/quotes', rejectApiKey, validateBody(createQuoteSchema), ok(async (req, res) => {
        const body = req.body as { quoteText: string; author?: string | null };
        const repo = repositories(req.channel!.id).quotes;

        const number = await repo.add(body.quoteText, body.author ?? null, req.claims?.sub ?? null);
        res.status(201).json(apiSuccess({
            quoteNumber: number,
            quoteText: body.quoteText,
            author: body.author ?? null
        } satisfies Quote));
    }));

    router.delete('/api/v1/quotes/:number', rejectApiKey, ok(async (req, res) => {
        const number = Number(req.params['number']);
        if (!Number.isInteger(number) || number < 1) {
            res.status(400).json(apiFailure('bad_request', 'quote number must be a positive integer'));
            return;
        }

        const deleted = await repositories(req.channel!.id).quotes.deleteByNumber(number);
        if (!deleted) {
            res.status(404).json(apiFailure('not_found', 'No such quote'));
            return;
        }
        res.status(204).end();
    }));

    // ---- songs (the only routes an API key may reach) ----------------------

    router.get('/api/v1/songs', ok(async (req, res) => {
        const queue = await songs(req.channel!.id).list();
        res.status(200).json(apiSuccess({ items: queue as QueuedSong[], total: queue.length }));
    }));

    router.delete('/api/v1/songs/head', ok(async (req, res) => {
        const skipped = await songs(req.channel!.id).removeHead();
        if (!skipped) {
            res.status(404).json(apiFailure('not_found', 'The queue is empty'));
            return;
        }

        options.publish?.(req.channel!.id, { type: 'song_queue.updated' });
        res.status(200).json(apiSuccess(skipped as QueuedSong));
    }));

    router.post(
        '/api/v1/songs/toggle',
        validateBody(toggleSongRequestsSchema),
        ok(async (req, res) => {
            const { enabled } = req.body as { enabled: boolean };
            await repositories(req.channel!.id).settings.update({ songRequestsEnabled: enabled });

            res.status(200).json(apiSuccess({ songRequestsEnabled: enabled }));
        })
    );

    // ---- dashboard ---------------------------------------------------------

    /**
     * The state the dashboard opens on.
     *
     * The realtime feed carries transitions; this carries the state those
     * transitions change. A client that connects mid-stream has missed every
     * transition that ever happened, so without this its uptime clock would not
     * start until the broadcaster went offline.
     *
     * Reports the CURRENT stream's numbers while live and the LAST stream's
     * when offline — the same shape either way, with `live` saying which. A
     * channel that has never streamed answers `null` and zeroes, and the client
     * renders the empty state; it never renders zeroes for a server it could
     * not reach, which is the `4b` rule and is enforced client-side because
     * this response cannot exist in that case.
     */
    router.get('/api/v1/dashboard', rejectApiKey, ok(async (req, res) => {
        const stream = await dashboard(req.channel!.id).currentOrLastStream();

        const numbers = stream
            ? await dashboard(req.channel!.id).numbersForStream(stream.id)
            : { messages: 0, chatters: 0, aiReplies: 0, pointsRedeemed: 0 };

        res.status(200).json(apiSuccess({
            // Live is a property of the stream row, not of the session: a
            // session that is stopped because the owner switched the bot off
            // does not make the broadcaster offline, and saying so would put
            // OFFLINE over a channel that is streaming.
            live: stream !== null && stream.endedAt === null,
            startedAt: stream && stream.endedAt === null ? stream.startedAt.toISOString() : null,
            numbers,
            lastStream: stream
                ? {
                    startedAt: stream.startedAt.toISOString(),
                    endedAt: stream.endedAt ? stream.endedAt.toISOString() : null
                }
                : null
        } satisfies DashboardSummary));
    }));

    // ---- analytics ---------------------------------------------------------

    router.get('/api/v1/analytics/summary', rejectApiKey, ok(async (req, res) => {
        // Correct over an empty dataset: a channel with no history reports
        // zeroes rather than failing, which is the state every new tenant is in.
        const summary = await analytics(req.channel!.id).summary();
        res.status(200).json(apiSuccess(summary satisfies AnalyticsSummary));
    }));

    // ---- api keys ----------------------------------------------------------

    router.get('/api/v1/api-keys', rejectApiKey, ok(async (req, res) => {
        const keys = await apiKeys.listFor(req.channel!.id);

        res.status(200).json(apiSuccess({
            items: keys.map((k): ApiKeySummary => ({
                id: k.id,
                name: k.name,
                prefix: k.prefix,
                createdAt: k.createdAt.toISOString(),
                lastUsedAt: k.lastUsedAt?.toISOString() ?? null
            })),
            total: keys.length
        }));
    }));

    router.post('/api/v1/api-keys', rejectApiKey, validateBody(createApiKeySchema), ok(async (req, res) => {
        const { name } = req.body as { name: string };
        const created = await apiKeys.create(req.channel!.id, name);

        // The only time the key exists outside the client's hands. There is no
        // recovery endpoint, deliberately.
        res.status(201).json(apiSuccess({
            id: created.id,
            name: created.name,
            prefix: created.prefix,
            createdAt: created.createdAt.toISOString(),
            lastUsedAt: null,
            key: created.key
        } satisfies CreatedApiKey));
    }));

    router.delete('/api/v1/api-keys/:id', rejectApiKey, ok(async (req, res) => {
        const revoked = await apiKeys.revoke(req.channel!.id, req.params['id'] as string);
        if (!revoked) {
            res.status(404).json(apiFailure('not_found', 'No such API key'));
            return;
        }
        res.status(204).end();
    }));

    return router;
}
