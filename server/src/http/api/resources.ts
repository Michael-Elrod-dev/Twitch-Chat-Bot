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
    type ChannelDisconnectedResponse,
    type DashboardSummary,
    type ApiKeySummary,
    type CreatedApiKey,
    type AnalyticsSummary,
    type AnalyticsRange,
    type QueuedSong,
    type Pagination,
    type UpdateSettingsRequest,
    type SpotifyStatus,
    type SpotifyPlaylist,
    type NowPlaying,
    type ManagedReward,
    type LiveSongQueueUpdated,
    analyticsQuerySchema
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
import type { SettingsService } from '../../domain/settings.js';
import type { ChannelSettingsRecord } from '../../db/repositories/channelSettingsRepository.js';
import type { ChannelRewardRepository, RewardKind as StoredRewardKind } from '../../db/repositories/channelRewardRepository.js';
import type { PlaybackState } from '../../spotify/spotifyClient.js';
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
    /**
     * The channel's data layer, **minus its settings**.
     *
     * The omission is the fix for Task 0 and is structural on purpose. Writing
     * settings straight through the repository leaves the running session's
     * `SettingsService` holding a cached copy for up to a minute, so the owner
     * flips a toggle in the app and the bot carries on as before — the content
     * hole again, wearing a shorter clock. Removing the repository from what a
     * route can reach means no future settings route can make that mistake by
     * forgetting something; there is simply no uninvalidating write available
     * to it. `settings` below is the only way in.
     */
    repositories: (channelId: string) => Omit<ChannelRepositories, 'settings'>;
    /**
     * Settings, read and written through the same cache the bot reads through.
     *
     * A `SettingsService` rather than the repository, because its `update`
     * drops the cache key as part of writing. That is what makes the change
     * take effect on the running session: one Redis, one key, and an
     * invalidation the session cannot miss because it never held a private
     * copy — which is why this needs no session seam of its own, unlike
     * commands and emotes.
     */
    settings: (channelId: string) => SettingsService;
    /** The tenancy root, for the one route that writes to the channel itself. */
    channels: ChannelRepository;
    apiKeys: ApiKeyRepository;
    analytics: (channelId: string) => AnalyticsRepository;
    dashboard: (channelId: string) => DashboardRepository;
    songs: (channelId: string) => SongQueueRepository;
    /**
     * Notifies live sockets. Optional so tests can omit it.
     *
     * Typed as the contract's own event minus the fields the bus stamps
     * (`channelId`, `at`), so a publisher cannot omit a payload field the
     * client is typed to read — which is how `queueLength` was declared and
     * never sent.
     */
    publish?: (channelId: string, event: Omit<LiveSongQueueUpdated, 'channelId' | 'at'>) => void;
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
    /**
     * Everything the songs screen needs from Spotify, for one channel.
     *
     * A seam for the same reason `spotifyConnected` is one: building a client
     * needs the token cipher, and a route handler must not be within reach of
     * the key to every stored credential. Optional, and absent means the whole
     * surface reports "not connected" — a deployment without Spotify
     * credentials under-reports rather than failing.
     */
    spotify?: (channelId: string) => SpotifySurface | null;
    /**
     * Resolves a playlist name to a Spotify id, creating one if needed.
     *
     * Separate from `spotify` because it is a *write* the settings screen
     * triggers, and because it must answer null rather than throw: a streamer
     * naming a playlist while Spotify is disconnected has made a reasonable
     * request the server cannot honour yet, and the name is still worth
     * keeping.
     */
    resolvePlaylist?: (channelId: string, name: string) => Promise<string | null>;
    /** The three bot-managed rewards, for the notifications screen's trust card. */
    rewards?: (channelId: string) => ChannelRewardRepository;
    /**
     * Removes the three managed rewards from Twitch as a channel disconnects.
     *
     * **Required, and for the same reason `reloadChannelContent` is.** A reward
     * left standing on a disconnected channel stays redeemable against a bot that
     * has left — a viewer spends points and nothing happens, which is the exact
     * failure the Spotify disconnect was made to prevent one route down. If this
     * were optional, a build that forgot it would compile, disconnect cleanly, and
     * keep charging viewers for a service that no longer exists.
     *
     * A seam rather than a Helix dependency because deleting a reward needs the
     * broadcaster's own token, and a route handler must not be within reach of the
     * key that decrypts every stored credential. The composition root decides what
     * to do when Twitch is unreachable — and, importantly, *says so in a log* —
     * rather than the route silently having no seam to call.
     *
     * Failures are the seam's own to report. Disconnecting must complete even when
     * Twitch refuses: a channel recorded as connected while its bot has gone is
     * the worse of the two wrong states.
     */
    releaseManagedRewards: (channelId: string) => Promise<void>;
}

/**
 * What the API does with Spotify on the app's behalf.
 *
 * Still deliberately narrower than `SpotifyClient` — nothing here can *queue* a
 * track, because a track reaching Spotify without a redemption behind it is the
 * one thing the whole songs design refuses.
 *
 * `skipPlayingTrack` was previously excluded on the reasoning that "skip already
 * has its own route against the bot's own queue". That reasoning was wrong, and
 * finding out why is what produced this method: `DELETE /songs/head` drops the
 * next **waiting** request, and the playback monitor has already handed the
 * playing track to Spotify and deleted it from our queue. So the two are
 * different actions on different songs, and the app had no way to perform the one
 * the design draws beside the now-playing card.
 */
export interface SpotifySurface {
    account: () => Promise<{ id: string; displayName: string } | null>;
    playlist: (playlistId: string) => Promise<SpotifyPlaylist | null>;
    playback: () => Promise<PlaybackState | null>;
    /**
     * Who requested the track now playing, or null when nobody here did.
     *
     * Synchronous because the answer is memory the running session holds: the
     * queue row is deleted at the moment the track is handed to Spotify, so by
     * the time it is playing there is nothing left to query.
     */
    requesterOf: (trackUri: string) => string | null;
    /**
     * Advances Spotify's player to the next track.
     *
     * Acts on what is PLAYING, never on the bot's waiting queue — see the note
     * above. Answers false when Spotify refused or had nothing to advance, so
     * the route can say "nothing is playing" rather than reporting a fault.
     */
    skipPlayingTrack: () => Promise<boolean>;
    /** Forgets the stored credential. @returns whether there was one. */
    disconnect: () => Promise<boolean>;
    connectedAt: () => Promise<Date | null>;
}

/**
 * The settings payload, built in exactly one place.
 *
 * `/me` and `PATCH /me/settings` both answer with it, and they used to build it
 * separately with a `satisfies` on each to stop them drifting. `satisfies`
 * catches a *missing* field; it cannot catch two sites disagreeing about what a
 * present one means. One function cannot disagree with itself.
 */
function toChannelSettings(
    stored: ChannelSettingsRecord,
    spotifyConnected: boolean
): ChannelSettings {
    return {
        aiEnabled: stored.aiEnabled,
        aiLimits: stored.aiLimits,
        songRequestsEnabled: stored.songRequestsEnabled,
        requestsPlaylistEnabled: stored.requestsPlaylistEnabled,
        requestsPlaylistName: stored.requestsPlaylistName,
        // Reported as a boolean, never as the URL: a webhook URL is a
        // capability, and echoing it back would let a stolen token exfiltrate
        // one.
        discordWebhookConfigured: stored.discordWebhookUrl !== null,
        // Same rule, same reason: presence, never the credential.
        spotifyConnected
    };
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
    const { logger, repositories, settings, apiKeys, analytics, dashboard, songs } = options;
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
        // Non-null whenever a channel is: `SettingsService.get` answers with
        // the defaults where no row has been written yet, so a freshly
        // onboarded channel renders its real (default) settings instead of the
        // `null` that means "no channel connected".
        const current = channel ? await settings(channel.id).get() : null;
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
            settings: current ? toChannelSettings(current, spotify) : null
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

            const patch = req.body as UpdateSettingsRequest;

            /*
             * Naming the playlist resolves it at Spotify, creating one if the
             * streamer has no playlist by that name yet.
             *
             * Done here rather than lazily at redemption time, because this is
             * the moment the streamer is looking at the screen: a name that
             * cannot be resolved should say so on the field they just typed
             * into, not fail silently three hours later when a viewer spends
             * points. `null` clears the id along with the name — a name and the
             * playlist it points at must not drift apart.
             */
            const named = patch.requestsPlaylistName;
            const resolvedId = named === undefined
                ? undefined
                : named === null
                    ? null
                    : (await options.resolvePlaylist?.(channel.id, named)) ?? null;

            /*
             * Built key by key rather than spread.
             *
             * `exactOptionalPropertyTypes` is on, and a spread of a parsed body
             * carries `key: undefined` for every field the client omitted — which
             * a partial update must treat as "not mentioned", not as a value. The
             * repository already distinguishes the two; this keeps the distinction
             * intact on the way in.
             */
            await settings(channel.id).update({
                ...(patch.aiEnabled === undefined ? {} : { aiEnabled: patch.aiEnabled }),
                ...(patch.aiLimits === undefined ? {} : { aiLimits: patch.aiLimits }),
                ...(patch.songRequestsEnabled === undefined
                    ? {}
                    : { songRequestsEnabled: patch.songRequestsEnabled }),
                ...(patch.requestsPlaylistEnabled === undefined
                    ? {}
                    : { requestsPlaylistEnabled: patch.requestsPlaylistEnabled }),
                ...(named === undefined ? {} : { requestsPlaylistName: named }),
                ...(resolvedId === undefined ? {} : { requestsPlaylistId: resolvedId }),
                ...(patch.discordWebhookUrl === undefined
                    ? {}
                    : { discordWebhookUrl: patch.discordWebhookUrl })
            });
            const updated = await settings(channel.id).get();

            res.status(200).json(apiSuccess(toChannelSettings(
                updated,
                await (options.spotifyConnected?.(channel.id) ?? false)
            )));
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

    /**
     * The danger zone: disconnecting the channel.
     *
     * One of the two destructive actions in the product, and the one the handoff
     * requires a confirmation for — the confirmation is the client's, but the
     * ordering here is what makes it safe to have only one.
     *
     * **Status first, then the teardown.** The write lands before anything is torn
     * down, for the same reason the master switch persists before acting: a channel
     * recorded as disconnected whose rewards we failed to remove is momentarily
     * untidy and self-corrects on the next attempt, whereas a channel whose rewards
     * are gone but which still reads `active` is a bot the owner believes is
     * running and which cannot be. The first is a mess; the second is a lie.
     *
     * **Rewards next, session last.** The reward removal needs the channel's
     * session-scoped credentials to still be reachable, and stopping the session
     * first would take them away — the ordering is load-bearing, not stylistic.
     *
     * **Nothing the streamer wrote is deleted.** Commands, emotes and quotes are
     * theirs and outlive the connection; the danger card promises exactly that, and
     * the promise is why coming back is worth doing. This route touches the channel
     * row, Twitch, and the running session. No content repository is reachable from
     * it at all.
     */
    router.delete('/api/v1/me/channel', rejectApiKey, ok(async (req, res) => {
        const channel = req.channel;
        if (!channel) {
            res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
            return;
        }

        const marked = await options.channels.setStatus(channel.id, 'disconnected');
        if (!marked) {
            res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
            return;
        }

        await options.releaseManagedRewards(channel.id);

        /*
         * `false`, not the channel's own `enabled` flag.
         *
         * The owner's pause preference is deliberately left untouched in the row —
         * it is theirs and it means nothing right now — but the running session
         * must go regardless of what it says. Passing `enabled` here would keep a
         * session alive for a channel that has just been torn down, and
         * `applyChannelEnabled` would happily rebuild it.
         *
         * Removing the session also drops this broadcaster from the transport's
         * desired subscription set, so the periodic reconcile pass unsubscribes at
         * Twitch on its own. That is why there is no unsubscribe call here: the
         * subscription model converges rather than being commanded, and a direct
         * call would be a second source of truth for the same thing.
         */
        await options.applyChannelEnabled?.(channel.id, false);

        const after = await options.channels.findById(channel.id);

        res.status(200).json(apiSuccess({
            // Read back from the row rather than assumed, exactly as the switch
            // does: the response is where the outcome is reported, not hoped for.
            enabled: after?.enabled ?? channel.enabled,
            status: after?.status ?? 'disconnected'
        } satisfies ChannelDisconnectedResponse));
    }));

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

            // Static command: `responseText` is its own description, so the
            // column stays null rather than repeating it.
            await repo.create({ ...body, handlerName: null, description: null });
            // Before responding: the client types the command in chat the second
            // it sees the row appear, so a reload that trailed the response
            // would lose that race for no reason.
            await options.reloadChannelContent(req.channel!.id, 'commands');
            res.status(201).json(apiSuccess({
                ...body, handlerName: null, description: null
            } satisfies Command));
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
        /*
         * `safeParse`, matching the command delete above it.
         *
         * `parse` throws, and a throw from inside a route handler lands in the
         * `internal` catch — so a trigger the schema simply does not like came
         * back as a 500 saying "Request failed", which tells the client the
         * server broke when the client sent something invalid. The envelope is
         * the whole contract for how the app places a message: `bad_request` goes
         * beside the field, `internal` becomes a banner. Getting the code wrong
         * puts the right words in the wrong place.
         */
        const parsed = emoteTriggerSchema.safeParse(req.params['trigger']);
        if (!parsed.success) {
            res.status(400).json(apiFailure('bad_request', 'invalid emote trigger'));
            return;
        }

        const deleted = await repositories(req.channel!.id).emotes.delete(parsed.data);

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
        const queue = songs(req.channel!.id);
        const skipped = await queue.removeHead();
        if (!skipped) {
            res.status(404).json(apiFailure('not_found', 'The queue is empty'));
            return;
        }

        /*
         * No publish here any more, and its absence is the point.
         *
         * This route used to be the ONLY publisher of `song_queue.updated`, which
         * is exactly why a song added by redemption was never announced: the news
         * was attached to one caller instead of to the change. `removeHead` now
         * announces for itself, as `add` does, so this route publishes by
         * mutating rather than by remembering to.
         */
        res.status(200).json(apiSuccess(skipped as QueuedSong));
    }));

    /**
     * Skips the track playing in Spotify.
     *
     * **This is not `DELETE /songs/head`, and the difference is the whole reason
     * it exists.** That route drops the next *waiting* request; this one advances
     * the player. The playback monitor hands a track to Spotify and deletes it
     * from our queue at that instant, so by the time a song is audible it is not
     * in the queue at all — which is why the app could draw a Skip button beside
     * the now-playing card and have nothing correct to call.
     *
     * Reachable by API key, like the rest of the songs group: "skip this song" is
     * exactly what a Stream Deck button is for, and it is narrower than the toggle
     * a key can already reach.
     *
     * Answers 204 rather than the new track. Spotify's player does not advance
     * synchronously, so reading it back here would usually return the track we
     * just skipped and tell the client something actively false. The client
     * re-reads instead.
     */
    router.post('/api/v1/songs/skip', ok(async (req, res) => {
        const surface = options.spotify?.(req.channel!.id) ?? null;
        if (!surface) {
            res.status(404).json(apiFailure('not_found', 'No Spotify account is connected'));
            return;
        }

        if (!await surface.skipPlayingTrack()) {
            // Nothing playing is not a fault. A Stream Deck press against a
            // silent player should say so, not report a broken bot.
            res.status(404).json(apiFailure('not_found', 'Nothing is playing to skip'));
            return;
        }

        res.status(204).end();
    }));

    /**
     * What Spotify is playing, for the now-playing card.
     *
     * Reachable by API key like the rest of the songs group: a Stream Deck
     * button that shows the current track is the same scope as one that skips
     * it, and narrower than one that does.
     */
    router.get('/api/v1/songs/playing', ok(async (req, res) => {
        const surface = options.spotify?.(req.channel!.id) ?? null;
        if (!surface) {
            // Not an error. A channel without Spotify has a card with an empty
            // state, and 404 here would make the client render a banner over a
            // perfectly healthy bot.
            res.status(200).json(apiSuccess(null));
            return;
        }

        const state = await surface.playback();
        if (!state || !state.trackUri || !state.trackName) {
            res.status(200).json(apiSuccess(null));
            return;
        }

        // Who asked for it, when it came from the request queue. The monitor
        // hands tracks to Spotify and removes them from our queue, so a
        // currently-playing request is no longer in the list - the played
        // record is where the requester survives.
        const requestedByLogin = surface.requesterOf(state.trackUri);

        res.status(200).json(apiSuccess({
            trackName: state.trackName,
            artistName: state.artistName ?? 'Unknown artist',
            albumArtUrl: state.albumArtUrl,
            progressMs: state.progressMs,
            durationMs: state.durationMs,
            isPlaying: state.isPlaying,
            requestedByLogin
        } satisfies NowPlaying));
    }));

    // ---- spotify -----------------------------------------------------------

    /**
     * The Spotify card: an account name, a date, and the requests playlist.
     *
     * Nothing here can authenticate. The seam that answers it holds the
     * credential; this handler sees a display name and a count.
     */
    router.get('/api/v1/spotify', rejectApiKey, ok(async (req, res) => {
        const surface = options.spotify?.(req.channel!.id) ?? null;
        const disconnected: SpotifyStatus = {
            connected: false, accountName: null, connectedSince: null, playlist: null
        };

        if (!surface) {
            res.status(200).json(apiSuccess(disconnected));
            return;
        }

        const account = await surface.account();
        if (!account) {
            // A stored credential Spotify no longer honours. Reported as
            // disconnected, because that is what it is from the streamer's
            // side - and the screen's Connect button is the fix.
            res.status(200).json(apiSuccess(disconnected));
            return;
        }

        const stored = await settings(req.channel!.id).get();
        const connectedAt = await surface.connectedAt();

        res.status(200).json(apiSuccess({
            connected: true,
            accountName: account.displayName,
            connectedSince: connectedAt ? connectedAt.toISOString() : null,
            // Null when no playlist is set, and also when the one we recorded
            // has since been deleted in the Spotify app - the card has nothing
            // to count either way.
            playlist: stored.requestsPlaylistId
                ? await surface.playlist(stored.requestsPlaylistId)
                : null
        } satisfies SpotifyStatus));
    }));

    /**
     * Unlinking Spotify.
     *
     * Song requests are switched off with it: the reward would otherwise stay
     * redeemable against a bot that can no longer fulfil it, which takes a
     * viewer's points for nothing.
     */
    router.delete('/api/v1/spotify', rejectApiKey, ok(async (req, res) => {
        const surface = options.spotify?.(req.channel!.id) ?? null;
        if (!surface || !await surface.disconnect()) {
            res.status(404).json(apiFailure('not_found', 'No Spotify account is connected'));
            return;
        }

        // The playlist id goes with the credential that could read it. Keeping
        // it would leave a stale pointer for the next account to append to.
        await settings(req.channel!.id).update({
            songRequestsEnabled: false,
            requestsPlaylistId: null
        });

        res.status(204).end();
    }));

    // ---- channel point rewards ---------------------------------------------

    /**
     * The three rewards this application manages, bound or not.
     *
     * The whole point of the card this feeds is the sentence beside it: no
     * other reward is ever touched. That claim is only worth making if the list
     * is closed, so the response enumerates the three kinds rather than
     * whatever happens to be in the table - an unbound kind reports
     * `bound: false` instead of vanishing.
     */
    router.get('/api/v1/rewards', rejectApiKey, ok(async (req, res) => {
        const repository = options.rewards?.(req.channel!.id);
        const stored = repository ? await repository.listAll() : [];
        const byKind = new Map(stored.map((reward) => [reward.kind, reward]));

        const kinds: StoredRewardKind[] = ['song_request', 'skip_queue', 'add_quote'];

        res.status(200).json(apiSuccess({
            items: kinds.map((kind): ManagedReward => {
                const reward = byKind.get(kind);
                return { kind, title: reward?.title ?? null, bound: reward !== undefined };
            })
        }));
    }));

    router.post(
        '/api/v1/songs/toggle',
        validateBody(toggleSongRequestsSchema),
        ok(async (req, res) => {
            const { enabled } = req.body as { enabled: boolean };
            // The Stream Deck's one-press toggle writes the same row the
            // settings screen does, so it takes the same invalidating path.
            await settings(req.channel!.id).update({ songRequestsEnabled: enabled });

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

    router.get(
        '/api/v1/analytics/summary',
        rejectApiKey,
        validateQuery(analyticsQuerySchema),
        ok(async (req, res) => {
            // Correct over an empty dataset: a channel with no history reports
            // zeroes rather than failing, which is the state every new tenant
            // is in — and the screen renders those real small numbers rather
            // than an apology.
            const { range } = getValidatedQuery<{ range: AnalyticsRange }>(req);
            const summary = await analytics(req.channel!.id).summary(range);
            res.status(200).json(apiSuccess(summary satisfies AnalyticsSummary));
        })
    );

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
