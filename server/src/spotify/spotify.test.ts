import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import { PlaybackMonitor } from './playbackMonitor.js';
import {
    parseTrackId, HttpSpotifyClient,
    type SpotifyClient, type SpotifyTrack, type PlaybackState, type SpotifyPlaylistInfo
} from './spotifyClient.js';
import { buildSpotifyAuthorizeUrl, SPOTIFY_SCOPES } from './spotifyAuth.js';
import { createSongRequestHandler, createSkipQueueHandler } from '../domain/songRedemption.js';
import { ChannelSession } from '../session/channelSession.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';
import type { SettingsService } from '../domain/settings.js';
import type { RedemptionEvent } from '@almosthadai/shared';

const logger = pino({ level: 'silent' });

const track = (overrides: Partial<SpotifyTrack> = {}): SpotifyTrack => ({
    uri: 'spotify:track:abc123',
    id: 'abc123',
    name: 'A Song',
    artist: 'An Artist',
    durationMs: 200_000,
    ...overrides
});

const redemption = (userInput: string): RedemptionEvent => ({
    kind: 'redemption',
    messageId: `m-${Math.random()}`,
    broadcasterTwitchId: '1001',
    redemptionId: 'r-1',
    rewardId: 'reward-song',
    rewardTitle: 'Song Request',
    userInput,
    redeemer: { twitchUserId: 'viewer-1', login: 'viewer', displayName: 'Viewer' }
});

/** A Spotify that answers from memory, so no test touches the network. */
class FakeSpotify implements SpotifyClient {
    tracks = new Map<string, SpotifyTrack>();
    searchResult: SpotifyTrack | null = null;
    playback: PlaybackState | null = null;
    readonly queued: string[] = [];
    skips = 0;
    failWith: Error | null = null;

    async getTrack(id: string): Promise<SpotifyTrack | null> {
        if (this.failWith) throw this.failWith;
        return this.tracks.get(id) ?? null;
    }

    async searchTrack(): Promise<SpotifyTrack | null> {
        if (this.failWith) throw this.failWith;
        return this.searchResult;
    }

    async getPlaybackState(): Promise<PlaybackState | null> {
        if (this.failWith) throw this.failWith;
        return this.playback;
    }

    async queueTrack(uri: string): Promise<void> {
        if (this.failWith) throw this.failWith;
        this.queued.push(uri);
    }

    async skipTrack(): Promise<void> { this.skips++; }
    async addToPlaylist(): Promise<void> { /* unused here */ }

    // The songs-screen reads. Present because the interface requires them, and
    // answering honestly (an account, no playlist) rather than throwing keeps a
    // future test that wanders in from failing for the wrong reason.
    async getCurrentUser(): Promise<{ id: string; displayName: string } | null> {
        return { id: 'spotify-user', displayName: 'Fake Account' };
    }

    async getPlaylist(): Promise<SpotifyPlaylistInfo | null> { return null; }

    async findPlaylistByName(): Promise<SpotifyPlaylistInfo | null> { return null; }

    async createPlaylist(_userId: string, name: string): Promise<SpotifyPlaylistInfo> {
        return { id: 'created-playlist', name, trackCount: 0 };
    }
}

// ---- pure units -------------------------------------------------------------

describe('parseTrackId', () => {
    it('reads every link shape a viewer pastes and rejects non-track input', () => {
        const rows: { name: string; input: string; expected: string | null }[] = [
            { name: 'spotify: URI', input: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', expected: '4cOdK2wGLETKBW3PvgPWqT' },
            { name: 'open.spotify.com link', input: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', expected: '4cOdK2wGLETKBW3PvgPWqT' },
            // The localized link is what the share button produces. A viewer
            // outside the US pastes this and it must not be treated as a search.
            { name: 'localized link', input: 'https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT', expected: '4cOdK2wGLETKBW3PvgPWqT' },
            { name: 'tracking query string', input: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123', expected: '4cOdK2wGLETKBW3PvgPWqT' },
            // Null is how the handler knows to search rather than look up.
            { name: 'plain search string', input: 'bohemian rhapsody', expected: null },
            { name: 'album link', input: 'https://open.spotify.com/album/abc', expected: null },
            { name: 'playlist URI', input: 'spotify:playlist:abc', expected: null }
        ];

        for (const row of rows) {
            expect(parseTrackId(row.input), row.name).toBe(row.expected);
        }
    });
});

describe('buildSpotifyAuthorizeUrl', () => {
    const config = {
        clientId: 'client', clientSecret: 'secret',
        redirectUri: 'https://almosthadai.duckdns.org/auth/spotify/callback'
    };

    it('requests exactly the scopes the bot uses', () => {
        const url = new URL(buildSpotifyAuthorizeUrl(config, 'state-value'));

        expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...SPOTIFY_SCOPES].sort());
    });

    it('never puts the client secret in the redirect', () => {
        expect(buildSpotifyAuthorizeUrl(config, 's')).not.toContain('secret');
    });

    it('forces the consent dialog so a different account can be connected', () => {
        expect(new URL(buildSpotifyAuthorizeUrl(config, 's')).searchParams.get('show_dialog')).toBe('true');
    });
});

// ---- the playback monitor ---------------------------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('Spotify integration', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    const settingsWith = (songRequestsEnabled: boolean): SettingsService =>
        ({
            get: async () => ({ aiEnabled: true, songRequestsEnabled, discordWebhookUrl: null })
        }) as unknown as SettingsService;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();

        alphaId = (await channels.upsert({
            twitchBroadcasterId: `sp-a-${stamp}`, twitchLogin: 'spalpha', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `sp-b-${stamp}`, twitchLogin: 'spbeta', displayName: null
        })).id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    beforeEach(async () => {
        for (const id of [alphaId, betaId]) {
            await handle.sql`delete from song_queue where channel_id = ${id}`;
        }
    });

    const queueFor = (channelId: string): SongQueueRepository =>
        new SongQueueRepository(handle.db, channelId, () => undefined);

    describe('THE PAUSE GATE', () => {
        it('does not advance the queue while playback is paused', async () => {
            // Without this a streamer who pauses for five minutes returns to an
            // empty queue: every track "ended" on the timer and went to Spotify
            // while nobody was listening. The viewers paid for songs nobody heard.
            const spotify = new FakeSpotify();
            spotify.playback = {
                isPlaying: false, trackUri: 'spotify:track:current', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:queued', trackName: 'Queued', artistName: 'A',
                requestedByTwitchUserId: null
            });

            const monitor = new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: queueFor(alphaId), logger
            });
            await monitor.tick();

            expect(spotify.queued).toHaveLength(0);
            expect(await queueFor(alphaId).count()).toBe(1);
        });

        it('advances when playback resumes near the end', async () => {
            const spotify = new FakeSpotify();
            spotify.playback = {
                isPlaying: true, trackUri: 'spotify:track:current', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:queued', trackName: 'Queued', artistName: 'A',
                requestedByTwitchUserId: null
            });

            await new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: queueFor(alphaId), logger
            }).tick();

            expect(spotify.queued).toEqual(['spotify:track:queued']);
            expect(await queueFor(alphaId).count()).toBe(0);
        });

        it('announces the queue it leaves behind when it hands a track off', async () => {
            /*
             * The second half of the invisible-row defect.
             *
             * The monitor removes the row a viewer is waiting on, and it told
             * nobody — so even a client that had somehow learned about the song
             * would have gone on rendering it after it was gone. The add half is
             * covered in the API suite; this is the removal half, at the only
             * place that performs it.
             */
            const announced: number[] = [];
            const watched = new SongQueueRepository(handle.db, alphaId, (n) => { announced.push(n); });

            const spotify = new FakeSpotify();
            spotify.playback = {
                isPlaying: true, trackUri: 'spotify:track:current', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await watched.add({
                trackUri: 'spotify:track:handoff', trackName: 'Handoff', artistName: 'A',
                requestedByTwitchUserId: null
            });
            await watched.add({
                trackUri: 'spotify:track:after', trackName: 'After', artistName: 'B',
                requestedByTwitchUserId: null
            });
            announced.length = 0;

            await new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: watched, logger
            }).tick();

            // One announcement, carrying the ONE song still waiting — not the two
            // there were before the handoff.
            expect(announced).toEqual([1]);
        });

        it('waits while the current track is only halfway through', async () => {
            const spotify = new FakeSpotify();
            spotify.playback = {
                isPlaying: true, trackUri: 'spotify:track:current', progressMs: 100_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:queued', trackName: 'Q', artistName: 'A',
                requestedByTwitchUserId: null
            });

            await new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: queueFor(alphaId), logger
            }).tick();

            expect(spotify.queued).toHaveLength(0);
        });

        it('does nothing when Spotify reports no active device', async () => {
            const spotify = new FakeSpotify();
            spotify.playback = null;

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:q', trackName: 'Q', artistName: 'A', requestedByTwitchUserId: null
            });

            await new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: queueFor(alphaId), logger
            }).tick();

            expect(spotify.queued).toHaveLength(0);
        });

        it('does not re-queue a track when removing it from the queue failed', async () => {
            // The guard's real case. queueTrack succeeds, removeHead then fails,
            // and the track is still at the head - so without remembering what
            // was just handed to Spotify, every subsequent tick queues it again.
            const spotify = new FakeSpotify();
            spotify.playback = {
                isPlaying: true, trackUri: 'spotify:track:current', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:queued', trackName: 'Q', artistName: 'A', requestedByTwitchUserId: null
            });

            const queue = queueFor(alphaId);
            const failingQueue = {
                list: () => queue.list(),
                removeHead: async () => { throw new Error('database blipped'); }
            } as unknown as SongQueueRepository;

            const monitor = new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: failingQueue, logger
            });
            await monitor.tick();
            await monitor.tick();
            await monitor.tick();

            expect(spotify.queued).toEqual(['spotify:track:queued']);
        });

        it('survives a Spotify outage and keeps the queue', async () => {
            const spotify = new FakeSpotify();
            spotify.failWith = new Error('spotify down');

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:q', trackName: 'Q', artistName: 'A', requestedByTwitchUserId: null
            });

            const monitor = new PlaybackMonitor({
                channelId: alphaId, client: spotify, queue: queueFor(alphaId), logger
            });

            await expect(monitor.tick()).resolves.toBeUndefined();
            expect(await queueFor(alphaId).count()).toBe(1);
        });
    });

    describe('monitor lifecycle (the P1-WP4 discipline)', () => {
        const build = (channelId: string): PlaybackMonitor => new PlaybackMonitor({
            channelId, client: new FakeSpotify(), queue: queueFor(channelId), logger,
            setIntervalImpl: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as typeof setInterval,
            clearIntervalImpl: (() => undefined) as typeof clearInterval
        });

        it('is idempotent on start', () => {
            const monitor = build(alphaId);
            monitor.start();
            monitor.start();

            expect(monitor.isRunning).toBe(true);
        });

        it('stops cleanly', () => {
            const monitor = build(alphaId);
            monitor.start();
            monitor.stop();

            expect(monitor.isRunning).toBe(false);
        });

        it('is safe to stop one that never started', () => {
            expect(() => build(alphaId).stop()).not.toThrow();
        });
    });

    describe('song request redemption', () => {
        const buildHandler = (channelId: string, spotify: FakeSpotify, enabled = true) =>
            createSongRequestHandler({
                spotify, queue: queueFor(channelId), settings: settingsWith(enabled), logger
            });

        const context = (channelId: string, input: string, sent: string[] = []) => ({
            event: redemption(input),
            channelId,
            reply: async (m: string) => { sent.push(m); }
        });

        it('queues a track from a pasted link', async () => {
            const spotify = new FakeSpotify();
            spotify.tracks.set('abc123', track());

            const reason = await buildHandler(alphaId, spotify)(
                context(alphaId, 'https://open.spotify.com/track/abc123')
            );

            expect(reason).toBeNull();
            expect(await queueFor(alphaId).count()).toBe(1);
        });

        it('searches when the input is not a link', async () => {
            const spotify = new FakeSpotify();
            spotify.searchResult = track({ name: 'Found By Search' });

            const reason = await buildHandler(alphaId, spotify)(context(alphaId, 'some song name'));

            expect(reason).toBeNull();
            expect((await queueFor(alphaId).list())[0]?.trackName).toBe('Found By Search');
        });

        describe('every failure refunds', () => {
            it('refunds every failure shape', async () => {
                const rows: { name: string; run: () => Promise<string | null>; expected: string }[] = [
                    {
                        name: 'empty input',
                        run: () => buildHandler(alphaId, new FakeSpotify())(context(alphaId, '  ')),
                        expected: 'refunded'
                    },
                    {
                        name: 'requests turned off',
                        run: () => {
                            const spotify = new FakeSpotify();
                            spotify.tracks.set('abc123', track());
                            return buildHandler(alphaId, spotify, false)(context(alphaId, 'spotify:track:abc123'));
                        },
                        expected: 'turned off'
                    },
                    {
                        name: 'unfindable track',
                        run: () => buildHandler(alphaId, new FakeSpotify())(context(alphaId, 'nonexistent song')),
                        expected: 'could not find'
                    },
                    {
                        name: 'track too long',
                        run: () => {
                            const spotify = new FakeSpotify();
                            spotify.tracks.set('abc123', track({ durationMs: 30 * 60_000 }));
                            return buildHandler(alphaId, spotify)(context(alphaId, 'spotify:track:abc123'));
                        },
                        expected: 'too long'
                    },
                    {
                        // A duplicate refunds rather than silently collapsing.
                        // The second viewer paid for nothing new.
                        name: 'duplicate request',
                        run: async () => {
                            const spotify = new FakeSpotify();
                            spotify.tracks.set('abc123', track());
                            const handler = buildHandler(alphaId, spotify);

                            await handler(context(alphaId, 'spotify:track:abc123'));
                            return handler(context(alphaId, 'spotify:track:abc123'));
                        },
                        expected: 'already in the queue'
                    },
                    {
                        name: 'Spotify unreachable',
                        run: () => {
                            const spotify = new FakeSpotify();
                            spotify.failWith = new Error('network down');
                            return buildHandler(alphaId, spotify)(context(alphaId, 'spotify:track:abc123'));
                        },
                        expected: 'refunded'
                    }
                ];

                for (const row of rows) {
                    expect(await row.run(), row.name).toContain(row.expected);
                }
            });
        });
    });

    describe('skip redemption', () => {
        it('removes the head of the queue', async () => {
            await queueFor(alphaId).add({
                trackUri: 'spotify:track:first', trackName: 'First', artistName: 'A',
                requestedByTwitchUserId: null
            });

            const sent: string[] = [];
            const reason = await createSkipQueueHandler({
                spotify: new FakeSpotify(), queue: queueFor(alphaId),
                settings: settingsWith(true), logger
            })({ event: redemption(''), channelId: alphaId, reply: async (m) => { sent.push(m); } });

            expect(reason).toBeNull();
            expect(await queueFor(alphaId).count()).toBe(0);
            expect(sent[0]).toContain('First');
        });

        it('refunds when there is nothing to skip', async () => {
            const reason = await createSkipQueueHandler({
                spotify: new FakeSpotify(), queue: queueFor(alphaId),
                settings: settingsWith(true), logger
            })({ event: redemption(''), channelId: alphaId, reply: async () => undefined });

            expect(reason).toContain('refunded');
        });
    });

    describe('THE CENTREPIECE: two channels, isolated queues and monitors', () => {
        it('keeps each channel queue separate', async () => {
            const spotify = new FakeSpotify();
            spotify.tracks.set('abc123', track({ name: 'Alpha Song' }));
            spotify.tracks.set('def456', track({ uri: 'spotify:track:def456', id: 'def456', name: 'Beta Song' }));

            await createSongRequestHandler({
                spotify, queue: queueFor(alphaId), settings: settingsWith(true), logger
            })({ event: redemption('spotify:track:abc123'), channelId: alphaId, reply: async () => undefined });

            await createSongRequestHandler({
                spotify, queue: queueFor(betaId), settings: settingsWith(true), logger
            })({ event: redemption('spotify:track:def456'), channelId: betaId, reply: async () => undefined });

            expect((await queueFor(alphaId).list()).map((s) => s.trackName)).toEqual(['Alpha Song']);
            expect((await queueFor(betaId).list()).map((s) => s.trackName)).toEqual(['Beta Song']);
        });

        it('lets both channels queue the same track independently', async () => {
            // A popular song is not a duplicate across channels.
            const spotify = new FakeSpotify();
            spotify.tracks.set('abc123', track());

            const a = createSongRequestHandler({
                spotify, queue: queueFor(alphaId), settings: settingsWith(true), logger
            });
            const b = createSongRequestHandler({
                spotify, queue: queueFor(betaId), settings: settingsWith(true), logger
            });

            expect(await a({ event: redemption('spotify:track:abc123'), channelId: alphaId, reply: async () => undefined })).toBeNull();
            expect(await b({ event: redemption('spotify:track:abc123'), channelId: betaId, reply: async () => undefined })).toBeNull();
        });

        it('one channel monitor never drains another channel queue', async () => {
            const alphaSpotify = new FakeSpotify();
            alphaSpotify.playback = {
                isPlaying: true, trackUri: 'spotify:track:current', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(alphaId).add({
                trackUri: 'spotify:track:alpha', trackName: 'A', artistName: 'A', requestedByTwitchUserId: null
            });
            await queueFor(betaId).add({
                trackUri: 'spotify:track:beta', trackName: 'B', artistName: 'B', requestedByTwitchUserId: null
            });

            await new PlaybackMonitor({
                channelId: alphaId, client: alphaSpotify, queue: queueFor(alphaId), logger
            }).tick();

            expect(alphaSpotify.queued).toEqual(['spotify:track:alpha']);
            expect(await queueFor(betaId).count()).toBe(1);
        });

        it('one channel Spotify being down leaves the other working', async () => {
            const broken = new FakeSpotify();
            broken.failWith = new Error('alpha spotify down');
            const working = new FakeSpotify();
            working.playback = {
                isPlaying: true, trackUri: 'x', progressMs: 195_000, durationMs: 200_000,
                trackName: 'Current', artistName: 'Someone', albumArtUrl: null
            };

            await queueFor(betaId).add({
                trackUri: 'spotify:track:beta', trackName: 'B', artistName: 'B', requestedByTwitchUserId: null
            });

            await new PlaybackMonitor({ channelId: alphaId, client: broken, queue: queueFor(alphaId), logger }).tick();
            await new PlaybackMonitor({ channelId: betaId, client: working, queue: queueFor(betaId), logger }).tick();

            expect(working.queued).toEqual(['spotify:track:beta']);
        });
    });

    describe('queue ordering', () => {
        it('serves oldest first', async () => {
            const queue = queueFor(alphaId);
            await queue.add({ trackUri: 'spotify:track:1', trackName: 'First', artistName: 'A', requestedByTwitchUserId: null });
            await queue.add({ trackUri: 'spotify:track:2', trackName: 'Second', artistName: 'A', requestedByTwitchUserId: null });

            expect((await queue.list()).map((s) => s.trackName)).toEqual(['First', 'Second']);
            expect((await queue.removeHead())?.trackName).toBe('First');
        });

        it('allocates distinct positions under concurrency', async () => {
            const queue = queueFor(betaId);
            await Promise.all([1, 2, 3, 4].map((n) => queue.add({
                trackUri: `spotify:track:c${n}`, trackName: `T${n}`, artistName: 'A', requestedByTwitchUserId: null
            })));

            const positions = await handle.sql<{ queue_position: number }[]>`
                select queue_position from song_queue where channel_id = ${betaId}`;
            expect(new Set(positions.map((p) => p.queue_position)).size).toBe(4);
        });
    });
});


describe('February 2026 platform changes', () => {
    /**
     * Spotify removed fifteen endpoints and renamed others in Feb/Mar 2026.
     * The playlist path is the one that bit us: `/tracks` was removed in favour
     * of `/items`, so the obvious spelling 404s in production.
     */
    it('uses the renamed playlist items path, not the removed tracks path', async () => {
        const calls: string[] = [];
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async (url: string | URL) => {
                calls.push(String(url));
                return new Response(null, { status: 204 });
            }) as unknown as typeof fetch
        });

        await client.addToPlaylist('playlist-1', 'spotify:track:abc');

        expect(calls[0]).toContain('/playlists/playlist-1/items');
        expect(calls[0]).not.toContain('/tracks');
    });

    /*
     * The songs-screen reads, at the fetch layer.
     *
     * These share the failure mode that already cost this file a production
     * incident: a call can be spelled almost right, answer 2xx, and be read
     * wrong. The seam double the route tests use cannot catch that — it is the
     * thing standing in for these — so the paths, the query strings and the
     * field names get asserted here against Spotify's real response shapes.
     */
    const recordingClient = (
        respond: (url: string) => Response
    ): { client: HttpSpotifyClient; calls: string[] } => {
        const calls: string[] = [];
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async (url: string | URL) => {
                calls.push(String(url));
                return respond(String(url));
            }) as unknown as typeof fetch
        });
        return { client, calls };
    };

    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    it('reads the linked account from /me', async () => {
        const { client, calls } = recordingClient(() => json({ id: 'user-1', display_name: 'Owner' }));

        expect(await client.getCurrentUser()).toEqual({ id: 'user-1', displayName: 'Owner' });
        expect(calls[0]).toContain('/me');
    });

    it('falls back to the account id when Spotify holds no display name', async () => {
        const { client } = recordingClient(() => json({ id: 'user-1', display_name: null }));

        // An account with no display name is allowed. The card would otherwise
        // render an empty line where a name goes.
        expect(await client.getCurrentUser()).toEqual({ id: 'user-1', displayName: 'user-1' });
    });

    it('asks for only the playlist fields the card shows', async () => {
        const { client, calls } = recordingClient(() =>
            json({ id: 'p1', name: 'Chat Requests', tracks: { total: 312 } }));

        expect(await client.getPlaylist('p1')).toEqual({
            id: 'p1', name: 'Chat Requests', trackCount: 312
        });
        // Without `fields`, the default response embeds the first hundred
        // tracks — a payload that grows all season for a name and a count.
        expect(calls[0]).toContain('fields=id,name,tracks(total)');
    });

    it('reports a deleted playlist as absent rather than failing', async () => {
        const { client } = recordingClient(() => new Response('{}', { status: 404 }));

        // Deleting a playlist in the Spotify app is an ordinary thing to have
        // done. The card shows nothing; it does not show an error.
        expect(await client.getPlaylist('gone')).toBeNull();
    });

    it('finds an existing playlist by name, case-insensitively', async () => {
        const { client } = recordingClient(() => json({
            items: [
                { id: 'other', name: 'Road Trip', tracks: { total: 4 } },
                { id: 'p1', name: 'Chat Requests', tracks: { total: 12 } }
            ],
            next: null
        }));

        // "chat requests" and "Chat Requests" are the same playlist to the
        // person who named it — and creating a second one is the failure this
        // lookup exists to prevent.
        expect(await client.findPlaylistByName('chat requests')).toEqual({
            id: 'p1', name: 'Chat Requests', trackCount: 12
        });
    });

    it('walks pages while Spotify says there are more', async () => {
        const pages = [
            json({ items: [{ id: 'a', name: 'A', tracks: { total: 1 } }], next: 'more' }),
            json({ items: [{ id: 'b', name: 'Wanted', tracks: { total: 2 } }], next: null })
        ];
        let page = 0;
        const { client, calls } = recordingClient(() => pages[page++] as Response);

        expect(await client.findPlaylistByName('wanted')).toMatchObject({ id: 'b' });
        expect(calls[1]).toContain('offset=50');
    });

    it('gives up at the page bound rather than walking forever', async () => {
        // Every page claims another follows. An unbounded walk here is a
        // settings save that never returns.
        const { client, calls } = recordingClient(() => json({ items: [], next: 'more' }));

        expect(await client.findPlaylistByName('never')).toBeNull();
        expect(calls).toHaveLength(10);
    });

    it('creates a private playlist under the account', async () => {
        const bodies: string[] = [];
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async (url: string | URL, init?: RequestInit) => {
                bodies.push(String(init?.body));
                return json({ id: 'new-1', name: 'Chat Requests', tracks: { total: 0 } });
            }) as unknown as typeof fetch
        });

        expect(await client.createPlaylist('user-1', 'Chat Requests'))
            .toEqual({ id: 'new-1', name: 'Chat Requests', trackCount: 0 });

        // Private by default: naming a playlist in our settings screen must not
        // decide that it appears on the streamer's public profile.
        expect(JSON.parse(bodies[0] as string)).toMatchObject({ name: 'Chat Requests', public: false });
    });

    it('reads the track name, artists and largest cover off the player', async () => {
        const { client } = recordingClient(() => json({
            is_playing: true,
            progress_ms: 94_000,
            item: {
                uri: 'spotify:track:abc',
                name: 'A Song',
                duration_ms: 243_000,
                artists: [{ name: 'One' }, { name: 'Two' }],
                album: { images: [{ url: 'small.jpg', width: 64 }, { url: 'big.jpg', width: 640 }] }
            }
        }));

        expect(await client.getPlaybackState()).toEqual({
            isPlaying: true,
            trackUri: 'spotify:track:abc',
            progressMs: 94_000,
            durationMs: 243_000,
            trackName: 'A Song',
            // Joined, not first-only: a collaboration listing one artist reads
            // as wrong to whoever requested it.
            artistName: 'One, Two',
            // Picked by width, not by position: the order is documented rather
            // than guaranteed in the payload.
            albumArtUrl: 'big.jpg'
        });
    });

    /**
     * The production bug, modelled on Spotify's actual reply.
     *
     * `POST /me/player/queue` answers 2xx with no JSON body. The client demanded
     * parseable JSON of every response, so each real success was thrown as
     * `failed with 200: response was not valid JSON`. The monitor honored its
     * own contract and refused to remove a track it believed had not been
     * queued — so it re-queued it every tick. Four ticks in the end window put
     * one track into Spotify's queue four times.
     *
     * The body varies (empty, whitespace, a bare status line); none of it is
     * JSON and none of it is read. Any 2xx is success.
     */
    for (const [label, body] of [
        ['an empty body', ''],
        ['a whitespace body', '\n'],
        ['a non-JSON body', 'OK']
    ] as const) {
        it(`treats a 2xx with ${label} as a successful queue add`, async () => {
            const client = new HttpSpotifyClient({
                accessToken: async () => 'token',
                logger,
                fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
            });

            await expect(client.queueTrack('spotify:track:abc')).resolves.toBeUndefined();
            await expect(client.skipTrack()).resolves.toBeUndefined();
        });
    }

    it('still reports a real failure on the no-content endpoints', async () => {
        // The counterweight: "any 2xx is success" must not decay into "anything
        // is success", or a failed add would drop the track silently.
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async () => new Response(
                JSON.stringify({ error: { message: 'Player command failed: No active device found' } }),
                { status: 403 }
            )) as unknown as typeof fetch
        });

        await expect(client.queueTrack('spotify:track:abc')).rejects.toThrow(/403/);
    });

    it('does not turn a 404 on a write into a success', async () => {
        /*
         * The mirror of the duplicate bug, and the worse direction. A read 404
         * means "no active device" and resolves to null; if a WRITE did the
         * same, the monitor would remove a track it never queued and the song
         * would vanish with nothing in any log.
         */
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch
        });

        await expect(client.queueTrack('spotify:track:abc')).rejects.toThrow(/404/);
        // Reads keep the old, correct behavior.
        await expect(client.getPlaybackState()).resolves.toBeNull();
    });

    it('still demands JSON where the body is actually read', async () => {
        // getTrack/search USE their bodies, so an unparseable one is a genuine
        // failure there and must stay one.
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
        });

        await expect(client.getTrack('abc')).rejects.toThrow(/not valid JSON/);
    });

    it('hands a track to Spotify exactly once across the end window', async () => {
        /*
         * The end-to-end shape of the production incident: four ticks inside the
         * ten-second window, against a client whose queue-add replies the way
         * Spotify really replies. Four adds and zero removals is the failure;
         * one add and one removal is correct.
         */
        let adds = 0;
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async (url: string | URL) => {
                if (String(url).includes('/me/player/queue')) {
                    adds++;
                    // NOT an empty body: the old code already returned null for
                    // that, so an empty reply here would let this test pass
                    // against the very client that caused the incident.
                    return new Response('OK', { status: 200 });
                }
                return new Response(JSON.stringify({
                    is_playing: true,
                    progress_ms: 175_000,
                    item: { uri: 'spotify:track:current', duration_ms: 180_000 }
                }), { status: 200 });
            }) as unknown as typeof fetch
        });

        const queued = [{ trackUri: 'spotify:track:doomed', trackName: 'Doomed', artistName: 'Maphra' }];
        const monitor = new PlaybackMonitor({
            channelId: 'ch-1',
            client,
            queue: {
                list: async () => [...queued],
                removeHead: async () => queued.shift() ?? null
            } as unknown as SongQueueRepository,
            logger
        });

        for (let i = 0; i < 4; i++) await monitor.tick();

        expect(adds).toBe(1);
        expect(queued).toEqual([]);
    });

    it('asks for a search limit inside the reduced maximum', async () => {
        // The max fell from 50 to 10. We ask for 1, so the change is a non-event
        // - but a future edit raising it would break silently.
        const calls: string[] = [];
        const client = new HttpSpotifyClient({
            accessToken: async () => 'token',
            logger,
            fetchImpl: (async (url: string | URL) => {
                calls.push(String(url));
                return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
            }) as unknown as typeof fetch
        });

        await client.searchTrack('anything');

        const limit = Number(new URL(calls[0] as string).searchParams.get('limit'));
        expect(limit).toBeLessThanOrEqual(10);
    });
});

describeDb('the monitor lifecycle belongs to the session', () => {
    /**
     * The live bug: the monitor was constructed but never started — not on
     * connect, and not even at boot. A channel with Spotify connected polled
     * nothing, and a queued track sat untouched through every track end.
     *
     * The fix puts the monitor's lifetime inside the session's, so "the session
     * is running" and "the monitor is polling" cannot disagree.
     */
    let handle: DbHandle;
    let channelId: string;
    /** Queue lengths the repository announced, in order. */
    const queueAnnouncements: number[] = [];

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        channelId = (await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: `mon-${Date.now()}`, twitchLogin: 'monitorchannel', displayName: null
        })).id;
    }, 60_000);

    beforeEach(() => { queueAnnouncements.length = 0; });

    afterAll(async () => {
        await handle?.close();
    });

    const buildMonitor = (client: SpotifyClient): PlaybackMonitor => new PlaybackMonitor({
        channelId,
        client,
        // Recording, because the monitor's handoff is the SECOND half of the
        // invisible-row defect: it removes the row the viewer is waiting on, and
        // it announced nothing either.
        queue: new SongQueueRepository(handle.db, channelId, (queueLength) => {
            queueAnnouncements.push(queueLength);
        }),
        logger,
        setIntervalImpl: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as typeof setInterval,
        clearIntervalImpl: (() => undefined) as typeof clearInterval
    });

    const buildSession = (monitor: PlaybackMonitor | undefined): ChannelSession => new ChannelSession({
        channelId,
        broadcasterTwitchId: '1001',
        logger,
        pipeline: { handle: async () => ({ action: 'none' as const }) } as never,
        commands: { load: async () => undefined } as never,
        emotes: { load: async () => undefined } as never,
        ...(monitor ? { monitor } : {})
    });

    it('starts the monitor when the session starts', async () => {
        const monitor = buildMonitor(new FakeSpotify());
        expect(monitor.isRunning).toBe(false);

        await buildSession(monitor).start();

        expect(monitor.isRunning).toBe(true);
    });

    it('stops the monitor when the session stops', async () => {
        // The symmetric case: a poller outliving its session keeps calling
        // Spotify for a channel the bot no longer serves.
        const monitor = buildMonitor(new FakeSpotify());
        const session = buildSession(monitor);

        await session.start();
        await session.stop();

        expect(monitor.isRunning).toBe(false);
    });

    it('does not start the monitor when the session fails to start', async () => {
        const monitor = buildMonitor(new FakeSpotify());
        const session = new ChannelSession({
            channelId,
            broadcasterTwitchId: '1001',
            logger,
            pipeline: { handle: async () => ({ action: 'none' as const }) } as never,
            commands: { load: async () => { throw new Error('load failed'); } } as never,
            emotes: { load: async () => undefined } as never,
            monitor
        });

        await expect(session.start()).rejects.toThrow('load failed');
        expect(monitor.isRunning).toBe(false);
    });

    it('runs a session with no monitor unchanged', async () => {
        // A channel without Spotify must still start and stop normally.
        const session = buildSession(undefined);

        await expect(session.start()).resolves.toBeUndefined();
        await expect(session.stop()).resolves.toBeUndefined();
    });

    it('stops itself when the Spotify authorization is dead', async () => {
        // Not transient: polling on would attempt an impossible refresh every
        // three seconds until somebody noticed.
        const spotify = new FakeSpotify();
        spotify.failWith = new ManualReauthRequiredError('spotify', channelId);

        const monitor = buildMonitor(spotify);
        monitor.start();
        expect(monitor.isRunning).toBe(true);

        await monitor.tick();

        expect(monitor.isRunning).toBe(false);
    });

    it('keeps polling through an ordinary Spotify error', async () => {
        const spotify = new FakeSpotify();
        spotify.failWith = new Error('temporary blip');

        const monitor = buildMonitor(spotify);
        monitor.start();
        await monitor.tick();

        expect(monitor.isRunning).toBe(true);
    });
});
