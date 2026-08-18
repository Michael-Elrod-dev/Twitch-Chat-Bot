import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { StreamRepository } from '../db/repositories/streamRepository.js';
import { StreamService } from './streamService.js';
import { createStreamHandlers } from './streamHandlers.js';
import type { HelixApi, HelixStream } from '../twitch/helixApi.js';
import type { HandlerContext } from './handlers.js';

const logger = pino({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

class FakeHelix {
    stream: HelixStream | null = {
        id: '48765430', userId: '1001', startedAt: '2026-08-16T10:00:00Z',
        title: 'ranked climb', gameName: 'Chess'
    };
    error: Error | null = null;

    async getStream(): Promise<HelixStream | null> {
        if (this.error) throw this.error;
        return this.stream;
    }
}

/** A reply-capturing handler context, matching what the pipeline supplies. */
function contextWith(replies: string[]): HandlerContext {
    return {
        args: [],
        reply: async (text: string) => { replies.push(text); }
    } as unknown as HandlerContext;
}

describeDb('streams', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        alphaId = (await channels.upsert({
            twitchBroadcasterId: `st-a-${Date.now()}`, twitchLogin: 'alphastream', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `st-b-${Date.now()}`, twitchLogin: 'betastream', displayName: null
        })).id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const repoFor = (channelId: string): StreamRepository => new StreamRepository(handle.db, channelId);

    const serviceFor = (
        channelId: string,
        options: { helix?: FakeHelix; now?: () => number } = {}
    ): StreamService => new StreamService({
        channelId,
        broadcasterTwitchId: '1001',
        streams: repoFor(channelId),
        logger,
        ...(options.helix ? { helix: options.helix as unknown as HelixApi } : {}),
        ...(options.now ? { now: options.now } : {})
    });

    /** Every test starts from a channel with no open stream. */
    beforeEach(async () => {
        for (const id of [alphaId, betaId]) {
            const open = await repoFor(id).findOpen();
            if (open) await repoFor(id).close(open.id, new Date());
        }
    });

    describe('the online path', () => {
        it('records the stream with Twitch own id, not a minted one', async () => {
            const service = serviceFor(alphaId, { helix: new FakeHelix() });
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));

            const open = await repoFor(alphaId).findOpen();
            // Twitch's own id, so the row can be matched against Twitch's
            // records. A locally minted id never can.
            expect(open?.twitchStreamId).toBe('48765430');
            expect(open?.title).toBe('ranked climb');
            expect(open?.category).toBe('Chess');
        });

        it('is idempotent when Twitch delivers stream.online twice', async () => {
            // EventSub is documented at-least-once. A second delivery must not
            // create a second stream, or every aggregate doubles.
            const service = serviceFor(alphaId, { helix: new FakeHelix() });
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));

            const rows = await handle.sql<{ count: string }[]>`
                select count(*)::text as count from streams
                where channel_id = ${alphaId} and twitch_stream_id = '48765430'`;
            expect(rows[0]?.count).toBe('1');
        });

        it('reopens the same stream when Twitch drops and returns', async () => {
            /*
             * Found by the isolation tests failing for a reason I had not
             * anticipated, and it is a production scenario rather than a test
             * artifact: Twitch keeps ONE stream id across a brief drop, so a
             * flaky connection delivers offline then online for the same stream.
             *
             * The upsert originally left `ended_at` set, so the row stayed
             * invisible to findOpen. The channel is live, the service believes
             * it is offline, and the AI bucket and !uptime stay wrong for the
             * rest of the stream.
             */
            const service = serviceFor(alphaId, { helix: new FakeHelix() });
            await service.onOnline('drop-1', new Date('2026-08-16T10:00:00Z'));
            const original = service.currentStreamId();

            await service.onOffline();
            expect(await repoFor(alphaId).findOpen()).toBeNull();

            await service.onOnline('drop-1', new Date('2026-08-16T10:00:00Z'));

            expect(service.currentStreamId()).toBe(original);
            expect(await repoFor(alphaId).findOpen()).not.toBeNull();
        });

        it('still records the stream when Helix metadata cannot be fetched', async () => {
            /*
             * Metadata is decoration; the row is load-bearing. Losing the row
             * because a title lookup failed would break the rate-limit bucket
             * and !uptime for the whole stream.
             */
            const helix = new FakeHelix();
            helix.error = new Error('helix unavailable');

            const service = serviceFor(alphaId, { helix });
            await service.onOnline('999', new Date('2026-08-16T10:00:00Z'));

            const open = await repoFor(alphaId).findOpen();
            expect(open?.twitchStreamId).toBe('999');
            expect(open?.title).toBeNull();
        });
    });

    describe('the offline path', () => {
        it('closes the stream and every viewing session still open in it', async () => {
            const service = serviceFor(alphaId, { helix: new FakeHelix() });
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));
            const streamId = service.currentStreamId() as string;

            await handle.sql`
                insert into viewers (twitch_user_id, login) values ('v1', 'watcher')
                on conflict (twitch_user_id) do nothing`;
            await handle.sql`
                insert into viewing_sessions (channel_id, stream_id, twitch_user_id, started_at)
                values (${alphaId}, ${streamId}, 'v1', now())`;

            await service.onOffline();

            const sessions = await handle.sql<{ ended_at: Date | null }[]>`
                select ended_at from viewing_sessions where stream_id = ${streamId}`;
            // A viewer still "watching" a stream that ended is an orphan
            // something else then has to sweep for on every boot.
            expect(sessions.every((s) => s.ended_at !== null)).toBe(true);
            expect(service.isLive).toBe(false);
        });

        it('closes a stream it never saw start', async () => {
            // The restart case: online arrived before the deploy, offline after.
            const first = serviceFor(alphaId, { helix: new FakeHelix() });
            await first.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));

            const afterRestart = serviceFor(alphaId, { helix: new FakeHelix() });
            await afterRestart.onOffline();

            expect(await repoFor(alphaId).findOpen()).toBeNull();
        });
    });

    describe('surviving a restart', () => {
        it('resumes the open stream instead of starting a new one', async () => {
            /*
             * Holding the stream id only in memory would make every deploy
             * silently begin a new "stream", resetting the AI allowance
             * mid-stream and restarting !uptime from zero.
             */
            const before = serviceFor(alphaId, { helix: new FakeHelix() });
            await before.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));
            const original = before.currentStreamId();

            const after = serviceFor(alphaId, { helix: new FakeHelix() });
            expect(after.currentStreamId()).toBeNull();

            await after.load();

            expect(after.currentStreamId()).toBe(original);
        });
    });

    describe('what the three consumers read', () => {
        const at = (iso: string) => () => new Date(iso).getTime();

        it('gives the AI the real title and category', async () => {
            const service = serviceFor(alphaId, {
                helix: new FakeHelix(),
                now: at('2026-08-16T12:30:00Z')
            });
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));

            expect(service.context()).toEqual({
                category: 'Chess',
                title: 'ranked climb',
                duration: '2h 30m'
            });
        });

        it('gives the AI nothing to claim when the channel is offline', async () => {
            // Worse than no context: stale context makes the bot assert a game
            // that is not being played.
            expect(serviceFor(alphaId).context()).toBeNull();
        });

        it('answers !uptime from the stream start, not the process start', async () => {
            const service = serviceFor(alphaId, {
                helix: new FakeHelix(),
                now: at('2026-08-16T13:45:00Z')
            });
            await service.onOnline('48765430', new Date('2026-08-16T10:00:00Z'));

            const replies: string[] = [];
            const handlers = createStreamHandlers({ streams: service, broadcasterLogin: 'alphastream' });
            await handlers['uptime']?.handler(contextWith(replies));

            expect(replies[0]).toBe('alphastream has been live for 3h 45m.');
        });

        it('says so rather than inventing an uptime when offline', async () => {
            const replies: string[] = [];
            const handlers = createStreamHandlers({
                streams: serviceFor(alphaId), broadcasterLogin: 'alphastream'
            });
            await handlers['uptime']?.handler(contextWith(replies));

            expect(replies[0]).toBe('alphastream is not live right now.');
        });
    });

    describe('two-channel isolation', () => {
        it('does not let one channel see or close another channel stream', async () => {
            const alpha = serviceFor(alphaId, { helix: new FakeHelix() });
            await alpha.onOnline('aaa', new Date('2026-08-16T10:00:00Z'));

            // Beta is offline and must stay that way.
            const beta = serviceFor(betaId, { helix: new FakeHelix() });
            await beta.load();
            expect(beta.currentStreamId()).toBeNull();
            expect(beta.context()).toBeNull();

            // Beta's repository must not be able to close alpha's stream even
            // when handed its id directly.
            const closed = await repoFor(betaId).close(alpha.currentStreamId() as string, new Date());
            expect(closed).toBe(false);
            expect(await repoFor(alphaId).findOpen()).not.toBeNull();
        });

        it('lets both channels be live at once without colliding', async () => {
            const alpha = serviceFor(alphaId, { helix: new FakeHelix() });
            const beta = serviceFor(betaId, { helix: new FakeHelix() });

            // The same Twitch stream id in two channels is not a conflict: the
            // unique index is (channel_id, twitch_stream_id), not the id alone.
            await alpha.onOnline('shared-id', new Date('2026-08-16T10:00:00Z'));
            await beta.onOnline('shared-id', new Date('2026-08-16T10:00:00Z'));

            expect(alpha.currentStreamId()).not.toBe(beta.currentStreamId());
        });
    });
});
