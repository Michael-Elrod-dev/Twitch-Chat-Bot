import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { pino } from 'pino';
import type { DbHandle } from '../../db/client.js';
import { connectTestDatabase } from '../../db/testing.js';
import { createApp } from '../app.js';
import { createResourceRouter, type SpotifySurface } from './resources.js';
import { createRequireJwt, createRequireChannelExceptMe, requireAnyCredential } from './middleware.js';
import { ChannelRepository } from '../../db/repositories/channelRepository.js';
import { ApiKeyRepository } from '../../db/repositories/apiKeyRepository.js';
import { AnalyticsRepository } from '../../db/repositories/analyticsRepository.js';
import { DashboardRepository } from '../../db/repositories/dashboardRepository.js';
import { SongQueueRepository } from '../../db/repositories/songQueueRepository.js';
import { ChannelRewardRepository } from '../../db/repositories/channelRewardRepository.js';
import { createChannelRepositories } from '../../bootstrap.js';
import { SettingsService } from '../../domain/settings.js';
import { nullCache } from '../../cache/testing.js';
import { signJwt } from '../../auth/jwt.js';
import type { LiveSongQueueUpdated } from '@almosthadai/shared';

/**
 * The songs, analytics and settings surface the app's final screens read.
 *
 * Two rules run through the whole file:
 *
 *  - Every read is checked against a second channel. Not because these routes
 *    take an id, since none of them does, but because "no route takes an id" is
 *    a property that has to keep being true as routes are added, and a test per
 *    route is what keeps it true.
 *  - The Spotify surface is a seam, and the double here is a real one. It
 *    records what it was asked and answers from state a test sets, so a route
 *    that stopped calling it, or called it with the wrong playlist, fails.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const JWT_SECRET = 'songs-settings-test-signing-secret';

/** A Spotify account and library a test can arrange. */
class FakeSurface implements SpotifySurface {
    accountName: string | null = 'Owner Account';
    since: Date | null = new Date('2026-08-04T10:00:00.000Z');
    playlists = new Map<string, { id: string; name: string; trackCount: number }>();
    nowPlaying: Awaited<ReturnType<SpotifySurface['playback']>> = null;
    requesters = new Map<string, string>();
    disconnected = false;
    /** Every playlist id the route asked about, in order. */
    readonly playlistLookups: string[] = [];

    async account(): Promise<{ id: string; displayName: string } | null> {
        return this.accountName === null ? null : { id: 'spotify-owner', displayName: this.accountName };
    }

    async playlist(playlistId: string): Promise<{ id: string; name: string; trackCount: number } | null> {
        this.playlistLookups.push(playlistId);
        return this.playlists.get(playlistId) ?? null;
    }

    async playback(): Promise<Awaited<ReturnType<SpotifySurface['playback']>>> {
        return this.nowPlaying;
    }

    requesterOf(trackUri: string): string | null {
        return this.requesters.get(trackUri) ?? null;
    }

    /** How many times the player was told to advance. */
    skips = 0;
    /** Set false to model an idle player, which Spotify refuses a skip against. */
    skippable = true;

    async skipPlayingTrack(): Promise<boolean> {
        if (!this.skippable) return false;
        this.skips += 1;
        return true;
    }

    async disconnect(): Promise<boolean> {
        if (this.disconnected) return false;
        this.disconnected = true;
        return true;
    }

    async connectedAt(): Promise<Date | null> {
        return this.since;
    }
}

describeDb('songs, analytics and settings', () => {
    let handle: DbHandle;
    let app: ReturnType<typeof createApp>;
    let alpha: { id: string; broadcasterId: string; token: string };
    let beta: { id: string; broadcasterId: string; token: string };
    let surfaces: Map<string, FakeSurface>;
    let published: { channelId: string; event: Omit<LiveSongQueueUpdated, 'channelId' | 'at'> }[];
    let resolvedNames: { channelId: string; name: string }[];
    /** What `resolvePlaylist` will answer next. Null models Spotify being unreachable. */
    let resolveTo: string | null;

    /**
     * A queue repository wired to the same recorder the live bus would be.
     *
     * Every construction of it in this file goes through here, deliberately: the
     * defect being guarded is "a queue mutation nobody announced", and a test
     * helper that quietly built a silent repository for *seeding* would recreate
     * exactly that blind spot inside the test that is supposed to catch it.
     */
    const recordingQueue = (channelId: string): SongQueueRepository =>
        new SongQueueRepository(handle.db, channelId, (queueLength) => {
            published.push({ channelId, event: { type: 'song_queue.updated', queueLength } });
        });

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();
        const a = await channels.upsert({
            twitchBroadcasterId: `songs-alpha-${stamp}`, twitchLogin: 'songsalpha', displayName: null
        });
        const b = await channels.upsert({
            twitchBroadcasterId: `songs-beta-${stamp}`, twitchLogin: 'songsbeta', displayName: null
        });

        alpha = {
            id: a.id,
            broadcasterId: a.twitchBroadcasterId,
            token: signJwt({ sub: a.twitchBroadcasterId, login: 'songsalpha' }, JWT_SECRET, 900)
        };
        beta = {
            id: b.id,
            broadcasterId: b.twitchBroadcasterId,
            token: signJwt({ sub: b.twitchBroadcasterId, login: 'songsbeta' }, JWT_SECRET, 900)
        };

        surfaces = new Map([[alpha.id, new FakeSurface()], [beta.id, new FakeSurface()]]);
        published = [];
        resolvedNames = [];
        resolveTo = 'resolved-playlist';

        const router = Router();
        router.use('/api/v1', createRequireJwt(JWT_SECRET, logger));
        router.use('/api/v1', requireAnyCredential);
        router.use(createRequireChannelExceptMe(channels));
        router.use(createResourceRouter({
            logger,
            repositories: (channelId) => createChannelRepositories(handle.db, channelId),
            settings: (channelId) => new SettingsService({
                channelId,
                repository: createChannelRepositories(handle.db, channelId).settings,
                cache: nullCache(),
                logger
            }),
            channels,
            apiKeys: new ApiKeyRepository(handle.db),
            analytics: (channelId) => new AnalyticsRepository(handle.db, channelId),
            dashboard: (channelId) => new DashboardRepository(handle.db, channelId),
            songs: (channelId) => recordingQueue(channelId),
            rewards: (channelId) => new ChannelRewardRepository(handle.db, channelId),
            spotify: (channelId) => surfaces.get(channelId) ?? null,
            resolvePlaylist: async (channelId, name) => {
                resolvedNames.push({ channelId, name });
                return resolveTo;
            },
            publish: (channelId, event) => { published.push({ channelId, event }); },
            // No disconnect in this suite; the release has nothing to let go of.
            releaseManagedRewards: async () => undefined,
            reloadChannelContent: async () => undefined
        }));

        app = createApp({ logger, version: 'test', routers: [router] });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    beforeEach(async () => {
        for (const id of [alpha.id, beta.id]) {
            await handle.sql`delete from song_queue where channel_id = ${id}`;
            await handle.sql`delete from channel_rewards where channel_id = ${id}`;
            await handle.sql`delete from channel_settings where channel_id = ${id}`;
            await handle.sql`delete from chat_messages where channel_id = ${id}`;
            await handle.sql`delete from chat_totals where channel_id = ${id}`;
            await handle.sql`delete from streams where channel_id = ${id}`;
        }
        published.length = 0;
        resolvedNames.length = 0;
        resolveTo = 'resolved-playlist';
        surfaces = new Map([[alpha.id, new FakeSurface()], [beta.id, new FakeSurface()]]);
    });

    const as = (who: { token: string }, req: request.Test): request.Test =>
        req.set('authorization', `Bearer ${who.token}`);

    // ---- AI limits ---------------------------------------------------------

    describe('AI limits', () => {
        it('opens on the defaults the limiter actually enforces', async () => {
            const response = await as(alpha, request(app).get('/api/v1/me')).expect(200);

            // Not arbitrary numbers: `DEFAULT_STREAM_LIMITS`, which is what a
            // channel that has never opened the screen is running under. A
            // screen that opened on a *proposal* would let the owner "save" a
            // change that changed nothing.
            expect(response.body.data.settings.aiLimits)
                .toEqual({ everyone: 5, vip: 10, subscriber: 15, moderator: 15 });
        });

        it('saves all four tiers and reads them back', async () => {
            const limits = { everyone: 1, vip: 2, subscriber: 3, moderator: 4 };
            const saved = await as(alpha, request(app).patch('/api/v1/me/settings').send({ aiLimits: limits }))
                .expect(200);

            expect(saved.body.data.aiLimits).toEqual(limits);

            const fetched = await as(alpha, request(app).get('/api/v1/me')).expect(200);
            expect(fetched.body.data.settings.aiLimits).toEqual(limits);
        });

        it('accepts zero, which turns one tier off without touching the others', async () => {
            const limits = { everyone: 0, vip: 5, subscriber: 5, moderator: 10 };
            const saved = await as(alpha, request(app).patch('/api/v1/me/settings').send({ aiLimits: limits }))
                .expect(200);

            expect(saved.body.data.aiLimits.everyone).toBe(0);
        });

        it('rejects a negative limit rather than storing it', async () => {
            // The schema's own rule, run by the server. A stored -1 would make
            // `used < limit` false for everyone forever, which reads in chat as
            // the AI being broken rather than as a setting.
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                aiLimits: { everyone: -1, vip: 5, subscriber: 5, moderator: 10 }
            })).expect(400);
        });

        it('rejects a partial set rather than merging one', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                aiLimits: { everyone: 3 }
            })).expect(400);
        });

        it('keeps one channel out of the other', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                aiLimits: { everyone: 1, vip: 1, subscriber: 1, moderator: 1 }
            })).expect(200);

            const other = await as(beta, request(app).get('/api/v1/me')).expect(200);
            expect(other.body.data.settings.aiLimits.everyone).toBe(5);
        });
    });

    // ---- the requests playlist ---------------------------------------------

    describe('requests playlist', () => {
        it('resolves the name to a playlist id when it is saved', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistEnabled: true,
                requestsPlaylistName: 'Chat Requests'
            })).expect(200);

            expect(resolvedNames).toEqual([{ channelId: alpha.id, name: 'Chat Requests' }]);

            const stored = await createChannelRepositories(handle.db, alpha.id).settings.get();
            expect(stored?.requestsPlaylistId).toBe('resolved-playlist');
        });

        it('keeps the name when Spotify cannot be reached to resolve it', async () => {
            resolveTo = null;

            const saved = await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Offline Name'
            })).expect(200);

            // The name is the streamer's; losing it because Spotify was down
            // would make them type it again for a failure they did not cause.
            expect(saved.body.data.requestsPlaylistName).toBe('Offline Name');

            const stored = await createChannelRepositories(handle.db, alpha.id).settings.get();
            expect(stored?.requestsPlaylistId).toBeNull();
        });

        it('clears the id along with the name', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Chat Requests'
            })).expect(200);

            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: null
            })).expect(200);

            const stored = await createChannelRepositories(handle.db, alpha.id).settings.get();
            // A name and the playlist it points at must not drift apart: a
            // cleared name over a live id would keep appending to a playlist
            // the screen no longer shows.
            expect(stored?.requestsPlaylistName).toBeNull();
            expect(stored?.requestsPlaylistId).toBeNull();
        });

        it('does not touch the playlist when the patch does not mention it', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Chat Requests'
            })).expect(200);
            resolvedNames.length = 0;

            await as(alpha, request(app).patch('/api/v1/me/settings').send({ aiEnabled: false })).expect(200);

            // Re-resolving on every unrelated save would hit Spotify, and create
            // a duplicate playlist, for a field nobody edited.
            expect(resolvedNames).toEqual([]);
            const stored = await createChannelRepositories(handle.db, alpha.id).settings.get();
            expect(stored?.requestsPlaylistId).toBe('resolved-playlist');
        });
    });

    // ---- the Spotify card ---------------------------------------------------

    describe('spotify status', () => {
        it('reports the linked account and when it was linked', async () => {
            const response = await as(alpha, request(app).get('/api/v1/spotify')).expect(200);

            expect(response.body.data).toMatchObject({
                connected: true,
                accountName: 'Owner Account',
                connectedSince: '2026-08-04T10:00:00.000Z'
            });
        });

        it('reports the requests playlist with its track count', async () => {
            surfaces.get(alpha.id)!.playlists.set('resolved-playlist', {
                id: 'resolved-playlist', name: 'Chat Requests', trackCount: 312
            });
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Chat Requests'
            })).expect(200);

            const response = await as(alpha, request(app).get('/api/v1/spotify')).expect(200);

            expect(response.body.data.playlist).toEqual({
                id: 'resolved-playlist', name: 'Chat Requests', trackCount: 312
            });
        });

        it('reports no playlist when the one we recorded has been deleted at Spotify', async () => {
            // The surface knows nothing about this id, which is a playlist the
            // streamer deleted in the Spotify app. The card must not claim a count.
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Gone'
            })).expect(200);

            const response = await as(alpha, request(app).get('/api/v1/spotify')).expect(200);
            expect(response.body.data.playlist).toBeNull();
            expect(response.body.data.connected).toBe(true);
        });

        it('reports disconnected when the stored credential no longer works', async () => {
            surfaces.get(alpha.id)!.accountName = null;

            const response = await as(alpha, request(app).get('/api/v1/spotify')).expect(200);
            expect(response.body.data).toEqual({
                connected: false, accountName: null, connectedSince: null, playlist: null
            });
        });

        it('never asks about another channel playlist', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                requestsPlaylistName: 'Alpha List'
            })).expect(200);

            await as(beta, request(app).get('/api/v1/spotify')).expect(200);

            // Beta has no playlist of its own, so beta's surface must have been
            // asked nothing, and alpha's must not have been used at all.
            expect(surfaces.get(beta.id)!.playlistLookups).toEqual([]);
            expect(surfaces.get(alpha.id)!.playlistLookups).toEqual([]);
        });

        it('switches song requests off when the account is disconnected', async () => {
            await as(alpha, request(app).patch('/api/v1/me/settings').send({
                songRequestsEnabled: true, requestsPlaylistName: 'Chat Requests'
            })).expect(200);

            await as(alpha, request(app).delete('/api/v1/spotify')).expect(204);

            const stored = await createChannelRepositories(handle.db, alpha.id).settings.get();
            // A reward that stays redeemable against a bot that can no longer
            // fulfill it takes a viewer's points for nothing.
            expect(stored?.songRequestsEnabled).toBe(false);
            expect(stored?.requestsPlaylistId).toBeNull();
        });

        it('answers 404 on a second disconnect rather than pretending', async () => {
            await as(alpha, request(app).delete('/api/v1/spotify')).expect(204);
            await as(alpha, request(app).delete('/api/v1/spotify')).expect(404);
        });

        it('leaves the other channel connected when one disconnects', async () => {
            await as(alpha, request(app).delete('/api/v1/spotify')).expect(204);

            const other = await as(beta, request(app).get('/api/v1/spotify')).expect(200);
            expect(other.body.data.connected).toBe(true);
        });
    });

    // ---- now playing --------------------------------------------------------

    describe('now playing', () => {
        const playing = {
            isPlaying: true,
            trackUri: 'spotify:track:abc',
            progressMs: 94_000,
            durationMs: 243_000,
            trackName: 'A Song',
            artistName: 'A Band',
            albumArtUrl: 'https://i.example/art.jpg'
        };

        it('returns the track with its requester', async () => {
            const surface = surfaces.get(alpha.id)!;
            surface.nowPlaying = playing;
            surface.requesters.set('spotify:track:abc', 'someviewer');

            const response = await as(alpha, request(app).get('/api/v1/songs/playing')).expect(200);

            expect(response.body.data).toEqual({
                trackName: 'A Song',
                artistName: 'A Band',
                albumArtUrl: 'https://i.example/art.jpg',
                progressMs: 94_000,
                durationMs: 243_000,
                isPlaying: true,
                requestedByLogin: 'someviewer'
            });
        });

        it('reports no requester for a track the streamer started themselves', async () => {
            surfaces.get(alpha.id)!.nowPlaying = playing;

            const response = await as(alpha, request(app).get('/api/v1/songs/playing')).expect(200);
            // Not "unknown" and not the last requester: crediting a stranger's
            // song to a viewer is worse than saying nothing.
            expect(response.body.data.requestedByLogin).toBeNull();
        });

        it('keeps the track while paused, with the flag saying so', async () => {
            surfaces.get(alpha.id)!.nowPlaying = { ...playing, isPlaying: false };

            const response = await as(alpha, request(app).get('/api/v1/songs/playing')).expect(200);
            // A paused player still has a track and a position. Blanking the
            // card would look like Spotify had gone away.
            expect(response.body.data.isPlaying).toBe(false);
            expect(response.body.data.trackName).toBe('A Song');
        });

        it('answers null, not an error, when nothing is playing', async () => {
            const response = await as(alpha, request(app).get('/api/v1/songs/playing')).expect(200);
            expect(response.body.data).toBeNull();
        });

        it('never reads another channel player', async () => {
            surfaces.get(alpha.id)!.nowPlaying = playing;

            const response = await as(beta, request(app).get('/api/v1/songs/playing')).expect(200);
            expect(response.body.data).toBeNull();
        });
    });

    // ---- skipping the PLAYING track -----------------------------------------

    describe('skipping what is playing', () => {
        const seedQueue = async (channelId: string): Promise<void> => {
            await handle.sql`
                insert into viewers (twitch_user_id, login)
                values ('skip-viewer', 'skipviewer')
                on conflict (twitch_user_id) do nothing
            `;
            await recordingQueue(channelId).add({
                trackUri: 'spotify:track:waiting',
                trackName: 'Still Waiting',
                artistName: 'Artist',
                requestedByTwitchUserId: 'skip-viewer'
            });
        };

        /**
         * Skip must advance the player and never touch the waiting queue. The
         * two are easy to conflate, because Skip sits beside the playing track
         * while a route that drops the next request looks similar, so this
         * asserts both halves at once. The player was told, and the queue that a
         * viewer paid into is exactly as it was.
         */
        it('advances the player and leaves every queued row alone', async () => {
            await seedQueue(alpha.id);
            const before = await recordingQueue(alpha.id).list();

            await as(alpha, request(app).post('/api/v1/songs/skip')).expect(204);

            expect(surfaces.get(alpha.id)?.skips).toBe(1);
            const after = await recordingQueue(alpha.id).list();
            expect(after.map((s) => s.trackUri)).toEqual(before.map((s) => s.trackUri));
            expect(after).toHaveLength(1);
        });

        it('answers not_found when nothing is playing, rather than reporting a fault', async () => {
            const surface = surfaces.get(alpha.id);
            if (surface) surface.skippable = false;

            const response = await as(alpha, request(app).post('/api/v1/songs/skip')).expect(404);

            // A Stream Deck press against a silent player should say so, not
            // claim the bot is broken.
            expect(response.body.error.code).toBe('not_found');
        });

        it('answers not_found when Spotify is not connected at all', async () => {
            surfaces.delete(alpha.id);

            await as(alpha, request(app).post('/api/v1/songs/skip')).expect(404);
        });

        it('never reaches another channel player', async () => {
            await as(alpha, request(app).post('/api/v1/songs/skip')).expect(204);

            expect(surfaces.get(beta.id)?.skips).toBe(0);
        });
    });

    // ---- the queue event ----------------------------------------------------

    describe('song queue events', () => {
        const seed = async (channelId: string, count: number): Promise<void> => {
            await handle.sql`
                insert into viewers (twitch_user_id, login)
                values ('queue-viewer', 'queueviewer')
                on conflict (twitch_user_id) do nothing
            `;
            for (let i = 0; i < count; i++) {
                await recordingQueue(channelId).add({
                    trackUri: `spotify:track:q${i}`,
                    trackName: `Track ${i}`,
                    artistName: 'Artist',
                    requestedByTwitchUserId: 'queue-viewer'
                });
            }
        };

        /**
         * A song added by redemption must announce the change. Without it the
         * app stays subscribed and waiting and never learns the row exists, so
         * the queue simply never appears.
         *
         * This is the assertion that was missing. Every other test in this block
         * exercised a *skip*, which was the one path that did publish, so the
         * whole suite was green over a queue that was invisible in normal use.
         */
        it('publishes when a song is ADDED, not only when one is skipped', async () => {
            await seed(alpha.id, 1);

            expect(published).toEqual([
                { channelId: alpha.id, event: { type: 'song_queue.updated', queueLength: 1 } }
            ]);
        });

        it('publishes a growing length as requests arrive', async () => {
            await seed(alpha.id, 3);

            // Three adds, three announcements, each carrying the queue a client
            // would render at that moment.
            expect(published.map((p) => p.event.queueLength)).toEqual([1, 2, 3]);
        });

        it('publishes the length left after a skip', async () => {
            await seed(alpha.id, 3);
            // The seeding announcements are the previous test's subject; this one
            // is about the skip, so the record starts here.
            published.length = 0;

            await as(alpha, request(app).delete('/api/v1/songs/head')).expect(200);

            // Two is the queue the client is about to render, not the one it had.
            expect(published).toEqual([
                { channelId: alpha.id, event: { type: 'song_queue.updated', queueLength: 2 } }
            ]);
        });

        it('publishes zero when the last song is skipped', async () => {
            await seed(alpha.id, 1);
            published.length = 0;

            await as(alpha, request(app).delete('/api/v1/songs/head')).expect(200);

            // Zero is a real number here, and an omitted field would have the
            // client render the previous count over an empty queue.
            expect(published[0]?.event.queueLength).toBe(0);
        });

        it('publishes nothing when there was nothing to skip', async () => {
            await as(alpha, request(app).delete('/api/v1/songs/head')).expect(404);
            expect(published).toEqual([]);
        });

        it('counts only the caller channel queue', async () => {
            await seed(alpha.id, 2);
            await seed(beta.id, 5);
            published.length = 0;

            await as(alpha, request(app).delete('/api/v1/songs/head')).expect(200);

            expect(published[0]?.event.queueLength).toBe(1);
        });
    });

    // ---- managed rewards ----------------------------------------------------

    describe('managed rewards', () => {
        it('lists all three kinds, bound or not', async () => {
            await new ChannelRewardRepository(handle.db, alpha.id).upsert({
                kind: 'song_request', rewardId: 'reward-1', title: 'Song Request'
            });

            const response = await as(alpha, request(app).get('/api/v1/rewards')).expect(200);

            // The closed list is the point: the card beside it promises that no
            // other reward is ever touched, and an unbound kind reporting
            // `bound: false` is what lets the screen say "not set up" instead
            // of quietly omitting a row.
            expect(response.body.data.items).toEqual([
                { kind: 'song_request', title: 'Song Request', bound: true },
                { kind: 'skip_queue', title: null, bound: false },
                { kind: 'add_quote', title: null, bound: false }
            ]);
        });

        it('does not show another channel rewards', async () => {
            await new ChannelRewardRepository(handle.db, alpha.id).upsert({
                kind: 'add_quote', rewardId: 'reward-2', title: 'Alpha Quote'
            });

            const response = await as(beta, request(app).get('/api/v1/rewards')).expect(200);
            expect(response.body.data.items.every((r: { bound: boolean }) => !r.bound)).toBe(true);
        });
    });

    // ---- analytics ranges ---------------------------------------------------

    describe('analytics ranges', () => {
        it('echoes the range back so a late response cannot mislabel a chip', async () => {
            const response = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=last_7_days')).expect(200);

            expect(response.body.data.range).toBe('last_7_days');
        });

        it('defaults to all time', async () => {
            const response = await as(alpha, request(app).get('/api/v1/analytics/summary')).expect(200);
            expect(response.body.data.range).toBe('all_time');
        });

        it('rejects a range it does not know', async () => {
            await as(alpha, request(app).get('/api/v1/analytics/summary?range=yesterday')).expect(400);
        });

        /**
         * Seeds two streams: an old one and the current one, with a different
         * number of messages in each.
         *
         * The point of the arrangement is that no two ranges can agree. An
         * assertion on the echoed `range` field alone would prove nothing,
         * because it passes against a repository that ignores the range
         * entirely.
         */
        const seedTwoStreams = async (): Promise<void> => {
            await handle.sql`
                insert into viewers (twitch_user_id, login) values
                    ('range-a', 'rangea'), ('range-b', 'rangeb')
                on conflict (twitch_user_id) do nothing
            `;

            const [old] = await handle.sql`
                insert into streams (channel_id, started_at, ended_at)
                values (${alpha.id}, now() - interval '40 days', now() - interval '40 days' + interval '2 hours')
                returning id
            `;
            const [current] = await handle.sql`
                insert into streams (channel_id, started_at)
                values (${alpha.id}, now() - interval '1 hour')
                returning id
            `;

            // Three in the old stream, well outside seven days.
            await handle.sql`
                insert into chat_messages (channel_id, stream_id, twitch_user_id, message_type, message_time)
                values
                    (${alpha.id}, ${old!['id']}, 'range-a', 'message', now() - interval '40 days'),
                    (${alpha.id}, ${old!['id']}, 'range-a', 'message', now() - interval '40 days'),
                    (${alpha.id}, ${old!['id']}, 'range-b', 'message', now() - interval '40 days')
            `;
            // One in the current stream.
            await handle.sql`
                insert into chat_messages (channel_id, stream_id, twitch_user_id, message_type, message_time)
                values (${alpha.id}, ${current!['id']}, 'range-a', 'message', now() - interval '10 minutes')
            `;
            // The lifetime counters the all-time range reads instead.
            await handle.sql`
                insert into chat_totals (channel_id, twitch_user_id, message_count, total_count)
                values (${alpha.id}, 'range-a', 3, 3), (${alpha.id}, 'range-b', 1, 1)
                on conflict (channel_id, twitch_user_id) do update
                    set message_count = excluded.message_count, total_count = excluded.total_count
            `;
        };

        const messagesFor = async (range: string): Promise<number> => {
            const response = await as(alpha, request(app)
                .get(`/api/v1/analytics/summary?range=${range}`)).expect(200);
            return response.body.data.messages as number;
        };

        it('counts a different set of messages for each range', async () => {
            await seedTwoStreams();

            // Four all time, one in the current stream, one inside seven days.
            // Three distinct answers from one dataset: a repository that
            // ignored the range could not produce them.
            expect(await messagesFor('all_time')).toBe(4);
            expect(await messagesFor('this_stream')).toBe(1);
            expect(await messagesFor('last_7_days')).toBe(1);
        });

        it('ranks top chatters within the range, not across all time', async () => {
            await seedTwoStreams();

            const lifetime = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=all_time')).expect(200);
            const recent = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=last_7_days')).expect(200);

            // `rangeb` said three things, but forty days ago. A seven-day chip
            // showing them at the top of the bars would be the range chip
            // doing nothing.
            expect(lifetime.body.data.topChatters[0].login).toBe('rangea');
            expect(recent.body.data.topChatters).toEqual([{ login: 'rangea', messageCount: 1 }]);
        });

        it('reports a stream nobody spoke in as zero, not one', async () => {
            await handle.sql`
                insert into streams (channel_id, started_at, ended_at)
                values (${alpha.id}, now() - interval '2 hours', now() - interval '1 hour')
            `;

            const response = await as(alpha, request(app).get('/api/v1/analytics/summary')).expect(200);

            // The LEFT JOIN produces one row for a stream with no messages, all
            // of the message side NULL. `count(*)` would report that silent
            // stream as having had one message - a number nobody could tell
            // from a real one.
            expect(response.body.data.recentStreams).toEqual([
                { startedAt: expect.any(String), endedAt: expect.any(String), messages: 0, chatters: 0 }
            ]);
        });

        it('reports real zeroes and an empty stream list for a young channel', async () => {
            const response = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=this_stream')).expect(200);

            // A channel that has never gone live is the state every new tenant
            // is in. Zeroes, not a 500 and not an apology.
            expect(response.body.data.messages).toBe(0);
            expect(response.body.data.recentStreams).toEqual([]);
        });
    });

    // ---- "this stream" means one thing ---------------------------------------

    describe('what "this stream" means', () => {
        /**
         * The dashboard and the analytics chip, asked the same question.
         *
         * Both screens scope to "this stream", the owner clicks between them in
         * the same second, and a message count that changes because the pane
         * changed is a bug reported as "the numbers are wrong" with no way to say
         * which number. Until the two shared a resolver this agreement was
         * asserted by a comment in each file and enforced by nothing.
         *
         * The case that separates them is the one the dashboard's own comment
         * names: **a crash leaves an older stream row open.** `ended_at is null`
         * then picks the older stream and `max(started_at)` picks the newer, so
         * two orderings that agree on every tidy channel disagree on the first
         * untidy one. Seeded here rather than hoped against, because it is the
         * only shape in which the defect is visible.
         */
        const seedCrashOrphanedStream = async (): Promise<void> => {
            await handle.sql`
                insert into viewers (twitch_user_id, login) values
                    ('orphan-a', 'orphana'), ('orphan-b', 'orphanb'),
                    ('newer-a', 'newera'), ('newer-b', 'newerb'), ('newer-c', 'newerc')
                on conflict (twitch_user_id) do nothing
            `;

            const [orphan] = await handle.sql`
                insert into streams (channel_id, started_at, ended_at)
                values (${alpha.id}, now() - interval '2 days', null)
                returning id
            `;
            const [newer] = await handle.sql`
                insert into streams (channel_id, started_at, ended_at)
                values (${alpha.id}, now() - interval '1 hour', now() - interval '30 minutes')
                returning id
            `;

            // Two in the stream that is still open, five in the newer closed
            // one. Deliberately different counts, and deliberately all of type
            // `message`: the dashboard counts everything that is not a
            // redemption and the analytics window counts `message`, so any other
            // type would let the two disagree for a reason that is not the bug.
            await handle.sql`
                insert into chat_messages (channel_id, stream_id, twitch_user_id, message_type, message_time)
                values
                    (${alpha.id}, ${orphan!['id']}, 'orphan-a', 'message', now() - interval '2 days'),
                    (${alpha.id}, ${orphan!['id']}, 'orphan-b', 'message', now() - interval '2 days'),
                    (${alpha.id}, ${newer!['id']}, 'newer-a', 'message', now() - interval '55 minutes'),
                    (${alpha.id}, ${newer!['id']}, 'newer-a', 'message', now() - interval '54 minutes'),
                    (${alpha.id}, ${newer!['id']}, 'newer-b', 'message', now() - interval '53 minutes'),
                    (${alpha.id}, ${newer!['id']}, 'newer-b', 'message', now() - interval '52 minutes'),
                    (${alpha.id}, ${newer!['id']}, 'newer-c', 'message', now() - interval '51 minutes')
            `;
        };

        it('gives the dashboard and the analytics chip the same stream', async () => {
            await seedCrashOrphanedStream();

            const dashboard = await as(alpha, request(app).get('/api/v1/dashboard')).expect(200);
            const analytics = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=this_stream')).expect(200);

            // The agreement itself is the assertion. One screen's figure equals
            // the other's, rather than each equalling a number typed here.
            expect(analytics.body.data.messages).toBe(dashboard.body.data.numbers.messages);
        });

        it('names the open stream, not the one that started most recently', async () => {
            await seedCrashOrphanedStream();

            const analytics = await as(alpha, request(app)
                .get('/api/v1/analytics/summary?range=this_stream')).expect(200);

            /*
             * The other half of the pin, and the reason the test above is not
             * enough on its own: two screens that both read the WRONG stream
             * agree perfectly. Two is the open stream's count and five is the
             * newer closed one's, so this says which of the two they agreed on.
             */
            expect(analytics.body.data.messages).toBe(2);
        });
    });
});
