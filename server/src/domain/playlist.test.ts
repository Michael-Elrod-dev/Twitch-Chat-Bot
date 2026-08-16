import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import { PlaylistRepository } from '../db/repositories/playlistRepository.js';
import { createSongRequestHandler } from './songRedemption.js';
import type { SettingsService } from './settings.js';
import type { SpotifyClient, SpotifyTrack } from '../spotify/spotifyClient.js';
import type { RedemptionEvent } from '@almosthadai/shared';

const logger = pino({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const TRACK: SpotifyTrack = {
    uri: 'spotify:track:playlisted', id: 'playlisted',
    name: 'Doomed', artist: 'Maphra', durationMs: 200_000
};

class FakeSpotify {
    readonly appended: { playlistId: string; uri: string }[] = [];
    /** Counts every call, so "never paged the playlist" is assertable. */
    calls = 0;
    failAppend = false;

    async getTrack(): Promise<SpotifyTrack> {
        this.calls++;
        return TRACK;
    }
    async searchTrack(): Promise<SpotifyTrack> {
        this.calls++;
        return TRACK;
    }
    async addToPlaylist(playlistId: string, uri: string): Promise<void> {
        this.calls++;
        if (this.failAppend) throw new Error('spotify refused');
        this.appended.push({ playlistId, uri });
    }
}

const redemption = (input: string): RedemptionEvent => ({
    kind: 'redemption',
    messageId: `pl-${Math.random()}`,
    broadcasterTwitchId: '1001',
    redemptionId: 'r1',
    rewardId: 'reward-song',
    rewardTitle: 'Song Request',
    userInput: input,
    redeemer: { twitchUserId: 'pl-viewer', login: 'requester', displayName: 'Requester' }
});

describeDb('the requests playlist', () => {
    let handle: DbHandle;
    let channelId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        channelId = (await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: `pl-${Date.now()}`, twitchLogin: 'playlistchannel', displayName: null
        })).id;

        await new ChannelRoleRepository(handle.db, channelId).upsertRoles('pl-viewer', 'requester', {
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    beforeEach(async () => {
        await handle.sql`delete from playlist_additions where channel_id = ${channelId}`;
        await handle.sql`delete from song_queue where channel_id = ${channelId}`;
    });

    const settingsWith = (over: Partial<{
        requestsPlaylistEnabled: boolean; requestsPlaylistId: string | null;
    }>): SettingsService => ({
        get: async () => ({
            aiEnabled: true,
            songRequestsEnabled: true,
            discordWebhookUrl: null,
            requestsPlaylistEnabled: false,
            requestsPlaylistName: null,
            requestsPlaylistId: null,
            ...over
        })
    }) as unknown as SettingsService;

    const handlerWith = (spotify: FakeSpotify, settings: SettingsService) => createSongRequestHandler({
        spotify: spotify as unknown as SpotifyClient,
        queue: new SongQueueRepository(handle.db, channelId),
        settings,
        logger,
        playlist: new PlaylistRepository(handle.db, channelId)
    });

    const context = (event: RedemptionEvent) => ({
        channelId,
        event,
        reply: async () => undefined
    });

    it('appends a requested track to the playlist', async () => {
        const spotify = new FakeSpotify();
        const handler = handlerWith(spotify, settingsWith({
            requestsPlaylistEnabled: true, requestsPlaylistId: 'playlist-abc'
        }));

        expect(await handler(context(redemption('spotify:track:playlisted')) as never)).toBeNull();

        expect(spotify.appended).toEqual([{ playlistId: 'playlist-abc', uri: TRACK.uri }]);
    });

    it('does not append when the streamer has not turned it on', async () => {
        const spotify = new FakeSpotify();
        const handler = handlerWith(spotify, settingsWith({
            requestsPlaylistEnabled: false, requestsPlaylistId: 'playlist-abc'
        }));

        await handler(context(redemption('spotify:track:playlisted')) as never);

        expect(spotify.appended).toEqual([]);
    });

    it('does not append when no playlist has been chosen yet', async () => {
        const spotify = new FakeSpotify();
        const handler = handlerWith(spotify, settingsWith({
            requestsPlaylistEnabled: true, requestsPlaylistId: null
        }));

        await handler(context(redemption('spotify:track:playlisted')) as never);

        expect(spotify.appended).toEqual([]);
    });

    it('dedups against the database, never by reading the playlist', async () => {
        /*
         * Phase 0 paged the entire playlist on every request to find duplicates
         * — an unbounded number of Spotify calls on the redemption path, growing
         * with the playlist. The call count is the assertion that the sin did
         * not come back with the feature.
         */
        const playlist = new PlaylistRepository(handle.db, channelId);
        expect(await playlist.claim('playlist-abc', TRACK.uri)).toBe(true);

        const spotify = new FakeSpotify();
        const handler = handlerWith(spotify, settingsWith({
            requestsPlaylistEnabled: true, requestsPlaylistId: 'playlist-abc'
        }));

        await handler(context(redemption('spotify:track:playlisted')) as never);

        expect(spotify.appended).toEqual([]);
        // One call: the track lookup. No playlist read, no append.
        expect(spotify.calls).toBe(1);
    });

    it('gives the track back when Spotify refuses the append', async () => {
        // A claim left behind after a failed append would record the track as
        // saved while Spotify never received it, and no later request would
        // ever retry it.
        const spotify = new FakeSpotify();
        spotify.failAppend = true;

        const handler = handlerWith(spotify, settingsWith({
            requestsPlaylistEnabled: true, requestsPlaylistId: 'playlist-abc'
        }));

        // Still succeeds: the song is queued, and a bookkeeping failure must
        // not cost the viewer their points.
        expect(await handler(context(redemption('spotify:track:playlisted')) as never)).toBeNull();

        const rows = await handle.sql<{ count: string }[]>`
            select count(*)::text as count from playlist_additions
            where channel_id = ${channelId} and track_uri = ${TRACK.uri}`;
        expect(rows[0]?.count).toBe('0');
    });

    it('saves the same track again for a new playlist', async () => {
        // A streamer starting a fresh playlist for a new season should get
        // their songs again, not silence.
        const playlist = new PlaylistRepository(handle.db, channelId);

        expect(await playlist.claim('season-one', TRACK.uri)).toBe(true);
        expect(await playlist.claim('season-one', TRACK.uri)).toBe(false);
        expect(await playlist.claim('season-two', TRACK.uri)).toBe(true);
    });

    it('releases only the claim for the playlist that failed', async () => {
        // Release is scoped to the playlist too. Dropping that scope would let
        // one failed append erase the record of the same track in every other
        // playlist, and it would be appended to them a second time.
        const playlist = new PlaylistRepository(handle.db, channelId);
        await playlist.claim('kept', TRACK.uri);
        await playlist.claim('failed', TRACK.uri);

        await playlist.release('failed', TRACK.uri);

        expect(await playlist.claim('kept', TRACK.uri)).toBe(false);
        expect(await playlist.claim('failed', TRACK.uri)).toBe(true);
    });

    it('lets exactly one of two simultaneous claims win', async () => {
        const playlist = new PlaylistRepository(handle.db, channelId);

        const results = await Promise.all(
            Array.from({ length: 5 }, () => playlist.claim('playlist-abc', 'spotify:track:race'))
        );

        expect(results.filter(Boolean)).toHaveLength(1);
    });
});
