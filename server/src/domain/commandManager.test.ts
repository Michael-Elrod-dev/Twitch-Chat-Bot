import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { CommandManager } from './commandManager.js';
import type { CommandRecord, CommandRepository } from '../db/repositories/commandRepository.js';
import type { CacheManager } from '../cache/cacheManager.js';
import type { HandlerRegistry } from './handlers.js';

/**
 * Ported behaviors from Phase 0 tests/commands/commandManager.test.js and
 * tests/commands/permissions.test.js — specifically the WP-6 task 9 findings:
 * one enforcement point, declaration beats the database row, and the row gets
 * corrected at load.
 */

const logger = pino({ level: 'silent' });

const viewer = { isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false };
const mod = { ...viewer, isModerator: true };

const makeRepo = (rows: CommandRecord[]) => {
    const store = [...rows];
    return {
        listAll: vi.fn(async () => [...store]),
        create: vi.fn(async (r: CommandRecord) => { store.push(r); }),
        updateResponse: vi.fn(async () => true),
        updateUserLevel: vi.fn(async (name: string, level: CommandRecord['userLevel']) => {
            const row = store.find((r) => r.name === name);
            if (row) row.userLevel = level;
        }),
        // Mutates the store like its sibling does. A no-op stub here would let
        // `load` write the same correction on every call and no test would see
        // it — the reconciliation is only observable if the row changes.
        updateDescription: vi.fn(async (name: string, description: string) => {
            const row = store.find((r) => r.name === name);
            if (row) row.description = description;
        }),
        delete: vi.fn(async () => true)
    } as unknown as CommandRepository & { updateUserLevel: ReturnType<typeof vi.fn> };
};

/** Cache that always misses non-authoritatively, so the DB path is exercised. */
const missingCache = (): CacheManager =>
    ({
        getHashField: vi.fn(async () => ({ hit: false, populated: false })),
        replaceHash: vi.fn(async () => true),
        getJson: vi.fn(async () => null),
        setJson: vi.fn(async () => true),
        del: vi.fn(async () => true)
    }) as unknown as CacheManager;

describe('CommandManager', () => {
    let cache: CacheManager;

    beforeEach(() => {
        cache = missingCache();
    });

    describe('lookup', () => {
        it('finds a command case-insensitively', async () => {
            const manager = new CommandManager({
                channelId: 'c1',
                repository: makeRepo([{ name: '!discord', responseText: 'link', handlerName: null, description: null, userLevel: 'everyone' }]),
                cache, logger
            });

            expect(await manager.get('!DISCORD')).toMatchObject({ name: '!discord' });
        });

        it('returns null for an unknown command', async () => {
            const manager = new CommandManager({ channelId: 'c1', repository: makeRepo([]), cache, logger });

            expect(await manager.get('!nope')).toBeNull();
        });

        it('trusts an authoritative cache miss without touching the database', async () => {
            const repository = makeRepo([]);
            const populatedCache = {
                ...missingCache(),
                getHashField: vi.fn(async () => ({ hit: false, populated: true }))
            } as unknown as CacheManager;

            const manager = new CommandManager({ channelId: 'c1', repository, cache: populatedCache, logger });
            expect(await manager.get('!nope')).toBeNull();

            // The whole point of the trim: an ordinary chat message costs no query.
            expect(repository.listAll).not.toHaveBeenCalled();
        });
    });

    describe('handler declarations beat the database row', () => {
        const handlers: HandlerRegistry = {
            skipSong: { handler: vi.fn(), level: 'mod', description: 'A test handler' }
        };

        it('resolves the declared level, not the stored one', async () => {
            const manager = new CommandManager({
                channelId: 'c1',
                repository: makeRepo([{ name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'everyone' }]),
                cache, logger, handlers
            });
            await manager.load();

            const command = await manager.get('!skip');
            expect(manager.resolveLevel(command!)).toBe('mod');
        });

        it('corrects the stale row at load so the table stops lying', async () => {
            const repository = makeRepo([
                { name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'everyone' }
            ]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger, handlers });

            await manager.load();

            expect(repository.updateUserLevel).toHaveBeenCalledWith('!skip', 'mod');
        });

        it('leaves an already-correct row alone', async () => {
            const repository = makeRepo([
                { name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'mod' }
            ]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger, handlers });

            await manager.load();

            expect(repository.updateUserLevel).not.toHaveBeenCalled();
        });

        it('writes the handler description onto the row so the API can serve it', async () => {
            const repository = makeRepo([
                { name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'mod' }
            ]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger, handlers });

            await manager.load();

            /*
             * The reply column has nothing else to show for a handler-backed
             * row. The description reaches the API through the row rather than
             * through the registry, because the API has no registry to
             * consult — the handlers are built per session, and a channel whose
             * bot is switched off has none.
             */
            expect(repository.updateDescription).toHaveBeenCalledWith('!skip', 'A test handler');
            expect((await manager.get('!skip'))?.description).toBe('A test handler');
        });

        it('leaves a description that already matches alone', async () => {
            const repository = makeRepo([
                {
                    name: '!skip', responseText: null, handlerName: 'skipSong',
                    description: 'A test handler', userLevel: 'mod'
                }
            ]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger, handlers });

            await manager.load();

            // Every session start loads; writing an unchanged row each time
            // would be one pointless UPDATE per built-in per boot.
            expect(repository.updateDescription).not.toHaveBeenCalled();
        });

        it('does not touch static commands', async () => {
            const repository = makeRepo([
                { name: '!discord', responseText: 'link', handlerName: null, description: null, userLevel: 'everyone' }
            ]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger, handlers });

            await manager.load();

            expect(repository.updateUserLevel).not.toHaveBeenCalled();
        });

        it('falls back to the stored level for a static command', async () => {
            const manager = new CommandManager({
                channelId: 'c1',
                repository: makeRepo([{ name: '!x', responseText: 'y', handlerName: null, description: null, userLevel: 'broadcaster' }]),
                cache, logger, handlers
            });
            await manager.load();

            expect(manager.resolveLevel((await manager.get('!x'))!)).toBe('broadcaster');
        });
    });

    describe('permission enforcement', () => {
        const handlers: HandlerRegistry = { skipSong: { handler: vi.fn(), level: 'mod', description: 'A test handler' } };

        it('blocks a viewer from a handler command declaring mod', async () => {
            const manager = new CommandManager({
                channelId: 'c1',
                repository: makeRepo([{ name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'everyone' }]),
                cache, logger, handlers
            });
            await manager.load();

            expect(manager.canRun((await manager.get('!skip'))!, viewer)).toBe(false);
        });

        it('allows a mod', async () => {
            const manager = new CommandManager({
                channelId: 'c1',
                repository: makeRepo([{ name: '!skip', responseText: null, handlerName: 'skipSong', description: null, userLevel: 'everyone' }]),
                cache, logger, handlers
            });
            await manager.load();

            expect(manager.canRun((await manager.get('!skip'))!, mod)).toBe(true);
        });

    });

    describe('cache population', () => {
        it('rewrites the channel-scoped hash on load', async () => {
            const manager = new CommandManager({
                channelId: 'chan-1',
                repository: makeRepo([{ name: '!a', responseText: 'x', handlerName: null, description: null, userLevel: 'everyone' }]),
                cache, logger
            });

            await manager.load();

            expect(cache.replaceHash).toHaveBeenCalledWith(
                'ch:chan-1:commands',
                expect.objectContaining({ '!a': expect.anything() }),
                expect.any(Number)
            );
        });

        it('reloads after a write so the cache cannot go stale', async () => {
            const repository = makeRepo([]);
            const manager = new CommandManager({ channelId: 'c1', repository, cache, logger });

            await manager.create({ name: '!new', responseText: 'hi', handlerName: null, description: null, userLevel: 'everyone' });

            expect(repository.listAll).toHaveBeenCalled();
            expect(await manager.get('!new')).toMatchObject({ name: '!new' });
        });
    });
});
