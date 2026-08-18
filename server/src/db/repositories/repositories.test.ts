import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '../client.js';
import { connectTestDatabase } from '../testing.js';
import { CommandRepository } from './commandRepository.js';
import { EmoteRepository } from './emoteRepository.js';
import { QuoteRepository } from './quoteRepository.js';
import { ChannelSettingsRepository } from './channelSettingsRepository.js';
import { ChannelRoleRepository } from './channelRoleRepository.js';

/**
 * Repository behavior against a real Postgres, with the emphasis on the thing
 * that matters most: a repository bound to one channel must be structurally
 * incapable of seeing another channel's rows.
 *
 * Skipped without TEST_DATABASE_URL so the suite stays dependency-free locally.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('repositories', () => {
    let handle: DbHandle;
    let sql: postgres.Sql;
    let channelA: string;
    let channelB: string;

    beforeAll(async () => {
        // Waits for a warming Postgres rather than failing on a cold stack.
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        sql = handle.sql;

        const stamp = Date.now();
        const [a] = await sql<{ id: string }[]>`
            insert into channels (twitch_broadcaster_id, twitch_login)
            values (${`repo-a-${stamp}`}, 'a') returning id`;
        const [b] = await sql<{ id: string }[]>`
            insert into channels (twitch_broadcaster_id, twitch_login)
            values (${`repo-b-${stamp}`}, 'b') returning id`;
        channelA = a!.id;
        channelB = b!.id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    describe('CommandRepository', () => {
        it('lists only its own channel commands', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            const repoB = new CommandRepository(handle.db, channelB);

            await repoA.create({ name: '!only-a', responseText: 'a', handlerName: null, description: null, userLevel: 'everyone' });

            expect((await repoA.listAll()).map((c) => c.name)).toContain('!only-a');
            expect((await repoB.listAll()).map((c) => c.name)).not.toContain('!only-a');
        });

        it('lets both channels hold the same command name independently', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            const repoB = new CommandRepository(handle.db, channelB);

            await repoA.create({ name: '!shared', responseText: 'from A', handlerName: null, description: null, userLevel: 'everyone' });
            await repoB.create({ name: '!shared', responseText: 'from B', handlerName: null, description: null, userLevel: 'everyone' });

            expect((await repoA.listAll()).find((c) => c.name === '!shared')?.responseText).toBe('from A');
            expect((await repoB.listAll()).find((c) => c.name === '!shared')?.responseText).toBe('from B');
        });

        it('cannot update another channel row', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            const repoB = new CommandRepository(handle.db, channelB);

            await repoA.create({ name: '!guarded', responseText: 'original', handlerName: null, description: null, userLevel: 'everyone' });

            expect(await repoB.updateResponse('!guarded', 'hijacked')).toBe(false);
            expect((await repoA.listAll()).find((c) => c.name === '!guarded')?.responseText).toBe('original');
        });

        it('cannot delete another channel row', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            const repoB = new CommandRepository(handle.db, channelB);

            await repoA.create({ name: '!undeletable', responseText: 'x', handlerName: null, description: null, userLevel: 'everyone' });

            expect(await repoB.delete('!undeletable')).toBe(false);
            expect((await repoA.listAll()).map((c) => c.name)).toContain('!undeletable');
        });

        it('normalizes names to lowercase', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            await repoA.create({ name: '!MiXeD', responseText: 'x', handlerName: null, description: null, userLevel: 'everyone' });

            expect((await repoA.listAll()).map((c) => c.name)).toContain('!mixed');
        });

        it('updates a user level', async () => {
            const repoA = new CommandRepository(handle.db, channelA);
            await repoA.create({ name: '!lvl', responseText: 'x', handlerName: 'h', description: null, userLevel: 'everyone' });

            await repoA.updateUserLevel('!lvl', 'mod');

            expect((await repoA.listAll()).find((c) => c.name === '!lvl')?.userLevel).toBe('mod');
        });
    });

    describe('EmoteRepository', () => {
        it('scopes emotes per channel', async () => {
            const repoA = new EmoteRepository(handle.db, channelA);
            const repoB = new EmoteRepository(handle.db, channelB);

            await repoA.create({ triggerText: 'aonly', responseText: 'A!' });

            expect((await repoA.listAll()).map((e) => e.triggerText)).toContain('aonly');
            expect((await repoB.listAll()).map((e) => e.triggerText)).not.toContain('aonly');
        });
    });

    describe('QuoteRepository', () => {
        it('numbers each channel quotes from 1 independently', async () => {
            const repoA = new QuoteRepository(handle.db, channelA);
            const repoB = new QuoteRepository(handle.db, channelB);

            expect(await repoA.add('first in A', 'someone', null)).toBe(1);
            expect(await repoB.add('first in B', 'someone', null)).toBe(1);
            expect(await repoA.add('second in A', 'someone', null)).toBe(2);
        });

        it('counts only its own channel', async () => {
            const repoA = new QuoteRepository(handle.db, channelA);
            const repoB = new QuoteRepository(handle.db, channelB);

            const before = await repoB.count();
            await repoA.add('another for A', null, null);

            expect(await repoB.count()).toBe(before);
        });

        it('reads a quote back by its number', async () => {
            const repoB = new QuoteRepository(handle.db, channelB);
            const number = await repoB.add('findable', 'author', null);

            expect(await repoB.getByNumber(number)).toMatchObject({ quoteText: 'findable', author: 'author' });
        });

        it('returns null for a number that does not exist', async () => {
            expect(await new QuoteRepository(handle.db, channelA).getByNumber(99_999)).toBeNull();
        });

        it('allocates distinct numbers under concurrency', async () => {
            // The read-then-insert is transactional with a row lock, so two
            // simultaneous saves cannot claim the same number (the P1-8 shape).
            const repo = new QuoteRepository(handle.db, channelB);
            const numbers = await Promise.all([
                repo.add('c1', null, null), repo.add('c2', null, null),
                repo.add('c3', null, null), repo.add('c4', null, null)
            ]);

            expect(new Set(numbers).size).toBe(numbers.length);
        });
    });

    describe('ChannelSettingsRepository', () => {
        it('returns null before any settings exist', async () => {
            const [fresh] = await sql<{ id: string }[]>`
                insert into channels (twitch_broadcaster_id, twitch_login)
                values (${`settings-${Date.now()}`}, 's') returning id`;

            expect(await new ChannelSettingsRepository(handle.db, fresh!.id).get()).toBeNull();
        });

        it('upserts the AI flag', async () => {
            const repo = new ChannelSettingsRepository(handle.db, channelA);

            await repo.setAiEnabled(false);
            expect((await repo.get())?.aiEnabled).toBe(false);

            await repo.setAiEnabled(true);
            expect((await repo.get())?.aiEnabled).toBe(true);
        });

        it('does not alter another channel settings', async () => {
            const repoA = new ChannelSettingsRepository(handle.db, channelA);
            const repoB = new ChannelSettingsRepository(handle.db, channelB);

            await repoA.setAiEnabled(false);
            await repoB.setAiEnabled(true);

            expect((await repoA.get())?.aiEnabled).toBe(false);
        });
    });

    describe('ChannelRoleRepository', () => {
        const userId = `role-user-${Date.now()}`;

        it('creates the viewer and the role together', async () => {
            const repo = new ChannelRoleRepository(handle.db, channelA);
            await repo.upsertRoles(userId, 'someone', {
                isModerator: true, isVip: false, isSubscriber: false, isBroadcaster: false
            });

            expect(await repo.get(userId)).toMatchObject({ isModerator: true });
        });

        it('keeps roles channel-relative for the same person', async () => {
            const repoA = new ChannelRoleRepository(handle.db, channelA);
            const repoB = new ChannelRoleRepository(handle.db, channelB);

            await repoA.upsertRoles(userId, 'someone', {
                isModerator: true, isVip: false, isSubscriber: false, isBroadcaster: false
            });
            await repoB.upsertRoles(userId, 'someone', {
                isModerator: false, isVip: true, isSubscriber: false, isBroadcaster: false
            });

            // The correction to Phase 0's global flags: a mod in one channel is
            // not a mod in the next.
            expect(await repoA.get(userId)).toMatchObject({ isModerator: true, isVip: false });
            expect(await repoB.get(userId)).toMatchObject({ isModerator: false, isVip: true });
        });

        it('touchPresence does NOT clear roles', async () => {
            // Phase 0's P1-1: a presence poll wrote default-false roles once a
            // minute and wiped everything the chat path had learned.
            const repo = new ChannelRoleRepository(handle.db, channelA);
            await repo.upsertRoles(userId, 'someone', {
                isModerator: true, isVip: true, isSubscriber: false, isBroadcaster: false
            });

            await repo.touchPresence(userId, 'someone');

            expect(await repo.get(userId)).toMatchObject({ isModerator: true, isVip: true });
        });

        it('returns null for a stranger', async () => {
            expect(await new ChannelRoleRepository(handle.db, channelA).get('nobody-here')).toBeNull();
        });
    });
});
