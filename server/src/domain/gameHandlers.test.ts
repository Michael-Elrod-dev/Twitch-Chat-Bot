import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { createGameHandlers } from './gameHandlers.js';
import { StubAiService } from '../services/aiService.js';
import type { HandlerContext } from './handlers.js';

const logger = pino({ level: 'silent' });

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

function contextFor(
    args: string[],
    chatter: { twitchUserId: string; login: string },
    replies: string[]
): HandlerContext {
    return {
        channelId: 'c',
        args,
        chatter: {
            twitchUserId: chatter.twitchUserId,
            login: chatter.login,
            displayName: chatter.login,
            isModerator: false,
            isVip: false,
            isSubscriber: false,
            isBroadcaster: false
        },
        reply: async (text: string) => { replies.push(text); }
    };
}

describeDb('!advice and !roast', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        alphaId = (await channels.upsert({
            twitchBroadcasterId: `gm-a-${Date.now()}`, twitchLogin: 'alphagame', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `gm-b-${Date.now()}`, twitchLogin: 'betagame', displayName: null
        })).id;

        // Someone alpha has seen, and someone only beta has seen.
        await new ChannelRoleRepository(handle.db, alphaId).upsertRoles('100', 'alphaviewer', {
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        });
        await new ChannelRoleRepository(handle.db, betaId).upsertRoles('200', 'betaviewer', {
            isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
        });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const handlersFor = (channelId: string, ai: StubAiService) => createGameHandlers({
        ai,
        roles: new ChannelRoleRepository(handle.db, channelId),
        logger
    });

    it('targets the named viewer', async () => {
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['roast']?.handler(
            contextFor(['@alphaviewer'], { twitchUserId: '999', login: 'asker' }, replies)
        );

        expect(ai.gameRequests).toHaveLength(1);
        expect(ai.gameRequests[0]?.type).toBe('roast');
        expect(ai.gameRequests[0]?.target.twitchUserId).toBe('100');
    });

    it('charges the requester, not the target', async () => {
        /*
         * Charging the target would let `!roast @victim`, a few times over,
         * exhaust the victim's allowance and lock them out of the bot entirely,
         * which is griefable by anyone who can type. The person who spends the
         * request pays.
         */
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['roast']?.handler(
            contextFor(['@alphaviewer'], { twitchUserId: '999', login: 'asker' }, replies)
        );

        expect(ai.gameRequests[0]?.target.twitchUserId).toBe('100');
        expect(ai.gameRequests[0]?.requester.twitchUserId).toBe('999');
    });

    it('targets the caller when no name is given', async () => {
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['advice']?.handler(
            contextFor([], { twitchUserId: '100', login: 'alphaviewer' }, replies)
        );

        expect(ai.gameRequests[0]?.type).toBe('advice');
        expect(ai.gameRequests[0]?.target.twitchUserId).toBe('100');
        // The degenerate self-target is still one charge to the one person.
        expect(ai.gameRequests[0]?.requester.twitchUserId).toBe('100');
    });

    it('says so rather than inventing a target it has never seen', async () => {
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['roast']?.handler(
            contextFor(['@ghost'], { twitchUserId: '999', login: 'asker' }, replies)
        );

        expect(ai.gameRequests).toHaveLength(0);
        expect(replies[0]).toContain('I have not seen ghost');
    });

    it('cannot name a viewer belonging to another channel', async () => {
        /*
         * Searching the whole `viewers` table would let `!roast @someone` in
         * one channel name a person who had only ever appeared in another,
         * leaking one tenant's audience into another's chat.
         */
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['roast']?.handler(
            contextFor(['@betaviewer'], { twitchUserId: '999', login: 'asker' }, replies)
        );

        expect(ai.gameRequests).toHaveLength(0);
        expect(replies[0]).toContain('I have not seen betaviewer');
    });

    it('addresses the answer to the target and the failure to the caller', async () => {
        // A successful roast is aimed at its subject, and an error goes back to
        // whoever typed the command.
        const ai = new StubAiService();
        const replies: string[] = [];

        await handlersFor(alphaId, ai)['roast']?.handler(
            contextFor(['@alphaviewer'], { twitchUserId: '999', login: 'asker' }, replies)
        );

        // The stub always fails, so this is the caller-addressed branch.
        expect(replies[0]).toContain('@asker');
    });
});
