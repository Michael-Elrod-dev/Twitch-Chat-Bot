import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { AnalyticsRepository } from '../db/repositories/analyticsRepository.js';
import { StreamRepository } from '../db/repositories/streamRepository.js';
import { StreamService } from '../domain/streamService.js';
import { DatabaseAnalyticsSink } from './analytics.js';
import type { ChatMessageEvent } from '@almosthadai/shared';

const logger = pino({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const message = (twitchUserId: string, login: string): ChatMessageEvent => ({
    kind: 'chat_message',
    messageId: `m-${Math.random()}`,
    broadcasterTwitchId: '1001',
    chatter: {
        twitchUserId, login, displayName: login,
        isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
    },
    text: 'hello'
});

describeDb('chat totals', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        const channels = new ChannelRepository(handle.db);
        alphaId = (await channels.upsert({
            twitchBroadcasterId: `an-a-${Date.now()}`, twitchLogin: 'alphaanalytics', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `an-b-${Date.now()}`, twitchLogin: 'betaanalytics', displayName: null
        })).id;

        // chat_totals references viewers; the chat path creates them upstream.
        for (const [id, login] of [['t1', 'chatterone'], ['t2', 'chattertwo'], ['shared', 'bothchannels']]) {
            await new ChannelRoleRepository(handle.db, alphaId).upsertRoles(id as string, login as string, {
                isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
            });
        }
        await new ChannelRoleRepository(handle.db, betaId).upsertRoles('shared', 'bothchannels', {
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const sinkFor = (channelId: string, currentStreamId?: () => string | null) => new DatabaseAnalyticsSink({
        analytics: new AnalyticsRepository(handle.db, channelId),
        streams: new StreamRepository(handle.db, channelId),
        ...(currentStreamId ? { currentStreamId } : {})
    });

    const totalsFor = async (channelId: string, twitchUserId: string) => {
        const [row] = await handle.sql<{
            message_count: number; command_count: number; redemption_count: number; total_count: number;
        }[]>`
            select message_count, command_count, redemption_count, total_count
            from chat_totals where channel_id = ${channelId} and twitch_user_id = ${twitchUserId}`;
        return row ?? null;
    };

    it('counts each interaction type into its own column', async () => {
        const sink = sinkFor(alphaId);

        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'command');
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'redemption');

        expect(await totalsFor(alphaId, 't1')).toEqual({
            message_count: 2, command_count: 1, redemption_count: 1, total_count: 4
        });
    });

    it('increments rather than overwrites under concurrency', async () => {
        // Read-modify-write would lose all but one of these.
        const sink = sinkFor(alphaId);

        await Promise.all(
            Array.from({ length: 8 }, () => sink.recordInteraction(alphaId, message('t2', 'chattertwo'), 'message'))
        );

        expect((await totalsFor(alphaId, 't2'))?.message_count).toBe(8);
    });

    it('keeps one viewer totals separate per channel', async () => {
        /*
         * The same person chats in both channels. Their totals are a property
         * of the person *in a channel* — one shared row would let either
         * broadcaster read the other's engagement numbers.
         */
        await sinkFor(alphaId).recordInteraction(alphaId, message('shared', 'bothchannels'), 'message');
        await sinkFor(alphaId).recordInteraction(alphaId, message('shared', 'bothchannels'), 'message');
        await sinkFor(betaId).recordInteraction(betaId, message('shared', 'bothchannels'), 'message');

        expect((await totalsFor(alphaId, 'shared'))?.message_count).toBe(2);
        expect((await totalsFor(betaId, 'shared'))?.message_count).toBe(1);
    });

    it('rolls the stream message count only while a stream is running', async () => {
        const streamRepository = new StreamRepository(handle.db, alphaId);
        const open = await streamRepository.findOpen();
        if (open) await streamRepository.close(open.id, new Date());

        const streams = new StreamService({
            channelId: alphaId,
            broadcasterTwitchId: '1001',
            streams: streamRepository,
            logger
        });

        // Offline first: the message counts for the viewer, against no stream.
        const sink = sinkFor(alphaId, () => streams.currentStreamId());
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');

        await streams.onOnline(`an-${Date.now()}`, new Date());
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');

        const [row] = await handle.sql<{ total_messages: number }[]>`
            select total_messages from streams where id = ${streams.currentStreamId() as string}`;
        expect(row?.total_messages).toBe(2);
    });

    it('does NOT roll the stream message count for a redemption', async () => {
        // Spending channel points is an interaction, and it belongs in the
        // viewer's totals — but it is not a line of chat, and counting it as one
        // would inflate the stream's message figure by every reward redeemed.
        const streamRepository = new StreamRepository(handle.db, alphaId);
        const open = await streamRepository.findOpen();
        if (open) await streamRepository.close(open.id, new Date());

        const streams = new StreamService({
            channelId: alphaId,
            broadcasterTwitchId: '1001',
            streams: streamRepository,
            logger
        });
        const sink = sinkFor(alphaId, () => streams.currentStreamId());
        await streams.onOnline(`redem-${Date.now()}`, new Date());

        // `t1` is one of the viewers seeded above; chat_totals references
        // viewers, so an id invented here would fail the key rather than the
        // assertion.
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'message');
        await sink.recordInteraction(alphaId, message('t1', 'chatterone'), 'redemption');

        const [row] = await handle.sql<{ total_messages: number }[]>`
            select total_messages from streams where id = ${streams.currentStreamId() as string}`;
        // One, not two: the chat line counted, the redemption did not.
        expect(row?.total_messages).toBe(1);
    });

    it('reports the real numbers through the analytics summary', async () => {
        // The end of the wire: the API surface that has been returning
        // structurally-correct zeroes since P1-WP7 now returns history.
        const summary = await new AnalyticsRepository(handle.db, betaId).summary();

        expect(summary.messages).toBeGreaterThan(0);
        expect(summary.topChatters[0]?.login).toBe('bothchannels');
    });
});
