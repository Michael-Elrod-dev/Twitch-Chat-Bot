import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { StreamRepository } from '../db/repositories/streamRepository.js';
import { StreamService } from './streamService.js';
import { PresenceTracker } from './presenceTracker.js';
import type { HelixApi } from '../twitch/helixApi.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

const logger = pino({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

class FakeHelix {
    chatters: { twitchUserId: string; login: string }[] = [];
    /** Counted so "did not poll" can be asserted directly. */
    calls = 0;

    async getChatters(): Promise<{ twitchUserId: string; login: string }[]> {
        this.calls++;
        return this.chatters;
    }
    async getStream(): Promise<null> {
        return null;
    }
}

describeDb('presence tracking', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        const channels = new ChannelRepository(handle.db);
        alphaId = (await channels.upsert({
            twitchBroadcasterId: `pr-a-${Date.now()}`, twitchLogin: 'alphapresence', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `pr-b-${Date.now()}`, twitchLogin: 'betapresence', displayName: null
        })).id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    async function setup(channelId: string, helix: FakeHelix, options: { token?: () => Promise<string> } = {}) {
        const streamRepository = new StreamRepository(handle.db, channelId);

        const open = await streamRepository.findOpen();
        if (open) await streamRepository.close(open.id, new Date());

        const streams = new StreamService({
            channelId,
            broadcasterTwitchId: '1001',
            streams: streamRepository,
            logger
        });
        await streams.onOnline(`s-${channelId}-${Date.now()}`, new Date());

        const tracker = new PresenceTracker({
            channelId,
            broadcasterTwitchId: '1001',
            streams,
            streamRepository,
            roles: new ChannelRoleRepository(handle.db, channelId),
            helix: helix as unknown as HelixApi,
            userToken: options.token ?? (async () => 'broadcaster-token'),
            logger,
            setIntervalImpl: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as typeof setInterval,
            clearIntervalImpl: (() => undefined) as typeof clearInterval
        });

        return { tracker, streams, streamRepository };
    }

    it('opens a viewing session for each chatter present', async () => {
        const helix = new FakeHelix();
        helix.chatters = [
            { twitchUserId: 'p1', login: 'watcherone' },
            { twitchUserId: 'p2', login: 'watchertwo' }
        ];

        const { tracker, streams, streamRepository } = await setup(alphaId, helix);
        await tracker.tick();

        const open = await streamRepository.openViewers(streams.currentStreamId() as string);
        expect(open.sort()).toEqual(['p1', 'p2']);
    });

    it('does not open a second session for someone already watching', async () => {
        const helix = new FakeHelix();
        helix.chatters = [{ twitchUserId: 'p3', login: 'steady' }];

        const { tracker, streams, streamRepository } = await setup(alphaId, helix);
        await tracker.tick();
        await tracker.tick();
        await tracker.tick();

        const rows = await handle.sql<{ count: string }[]>`
            select count(*)::text as count from viewing_sessions
            where stream_id = ${streams.currentStreamId() as string} and twitch_user_id = 'p3'`;
        expect(rows[0]?.count).toBe('1');

        expect(await streamRepository.openViewers(streams.currentStreamId() as string)).toEqual(['p3']);
    });

    it('closes the session of a viewer who has left', async () => {
        const helix = new FakeHelix();
        helix.chatters = [
            { twitchUserId: 'p4', login: 'stays' },
            { twitchUserId: 'p5', login: 'leaves' }
        ];

        const { tracker, streams, streamRepository } = await setup(alphaId, helix);
        await tracker.tick();

        helix.chatters = [{ twitchUserId: 'p4', login: 'stays' }];
        await tracker.tick();

        expect(await streamRepository.openViewers(streams.currentStreamId() as string)).toEqual(['p4']);
    });

    it('writes presence without touching a single role column', async () => {
        /*
         * This is why touchPresence exists at all. A poll that wrote role
         * columns with defaults would erase every moderator and VIP the chat
         * path had learned, once a minute. The chatters endpoint carries no role
         * information, so inventing one is a lie.
         */
        const roles = new ChannelRoleRepository(handle.db, alphaId);
        await roles.upsertRoles('p6', 'themod', {
            isModerator: true, isVip: true, isSubscriber: true, isBroadcaster: false
        });

        const helix = new FakeHelix();
        helix.chatters = [{ twitchUserId: 'p6', login: 'themod' }];

        const { tracker } = await setup(alphaId, helix);
        await tracker.tick();

        expect(await roles.get('p6')).toEqual({
            isModerator: true, isVip: true, isSubscriber: true, isBroadcaster: false
        });
    });

    it('does not even call Helix while the channel is offline', async () => {
        /*
         * Asserted on the Helix call rather than on the absence of rows: with
         * the offline gate removed, the insert fails on its own (stream_id is
         * NOT NULL) and a row-count assertion still passes. That version of
         * this test would prove nothing, because it could not tell "the gate
         * held" from "the gate was gone and the database refused the write".
         *
         * The real intent is that an offline channel costs no Helix quota.
         */
        const helix = new FakeHelix();
        helix.chatters = [{ twitchUserId: 'p7', login: 'ghost' }];

        const { tracker, streams } = await setup(alphaId, helix);
        await streams.onOffline();

        await tracker.tick();

        expect(helix.calls).toBe(0);

        const rows = await handle.sql<{ count: string }[]>`
            select count(*)::text as count from viewing_sessions where twitch_user_id = 'p7'`;
        expect(rows[0]?.count).toBe('0');
    });

    it('stops itself when the broadcaster authorization is dead', async () => {
        // Not transient: polling on would attempt an impossible refresh every
        // minute until somebody noticed.
        const helix = new FakeHelix();
        helix.chatters = [{ twitchUserId: 'p8', login: 'someone' }];

        const { tracker } = await setup(alphaId, helix, {
            token: async () => { throw new ManualReauthRequiredError('broadcaster token', alphaId); }
        });

        tracker.start();
        expect(tracker.isRunning).toBe(true);

        await tracker.tick();

        expect(tracker.isRunning).toBe(false);
    });

    it('keeps polling after an ordinary failure', async () => {
        const helix = new FakeHelix();
        const { tracker } = await setup(alphaId, helix, {
            token: async () => { throw new Error('helix hiccup'); }
        });

        tracker.start();
        await tracker.tick();

        expect(tracker.isRunning).toBe(true);
        tracker.stop();
    });

    it('keeps two channels presence entirely separate', async () => {
        const alphaHelix = new FakeHelix();
        alphaHelix.chatters = [{ twitchUserId: 'shared-viewer', login: 'bothchannels' }];
        const betaHelix = new FakeHelix();
        betaHelix.chatters = [];

        const alpha = await setup(alphaId, alphaHelix);
        const beta = await setup(betaId, betaHelix);

        await alpha.tracker.tick();
        await beta.tracker.tick();

        // The same person can watch both channels; one channel's poll must not
        // open or close the other's sessions.
        expect(await alpha.streamRepository.openViewers(alpha.streams.currentStreamId() as string))
            .toEqual(['shared-viewer']);
        expect(await beta.streamRepository.openViewers(beta.streams.currentStreamId() as string))
            .toEqual([]);
    });
});
