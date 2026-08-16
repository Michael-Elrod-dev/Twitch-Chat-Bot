import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { CacheManager } from './cacheManager.js';
import { channelKey, CacheKeys } from './keys.js';
import type { RedisHandle } from './redis.js';

/**
 * Redis-down fallback is house law: every method degrades to a miss and none of
 * them throw. Phase 0 proved a bot that survives a Redis outage; that guarantee
 * does not get to weaken because the code is now TypeScript.
 */

const logger = pino({ level: 'silent' });

interface FakeClient {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    hget: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    multi: ReturnType<typeof vi.fn>;
}

describe('CacheManager', () => {
    let client: FakeClient;
    let available: boolean;
    let cache: CacheManager;
    let pipeline: { del: ReturnType<typeof vi.fn>; hset: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        available = true;
        pipeline = {
            del: vi.fn().mockReturnThis(),
            hset: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([])
        };
        client = {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            hget: vi.fn().mockResolvedValue(null),
            exists: vi.fn().mockResolvedValue(0),
            multi: vi.fn(() => pipeline)
        };

        cache = new CacheManager(
            { client, isAvailable: () => available } as unknown as RedisHandle,
            logger
        );
    });

    describe('key scoping', () => {
        it('prefixes every key with its channel', () => {
            expect(channelKey('abc', 'commands')).toBe('ch:abc:commands');
            expect(CacheKeys.commands('abc')).toBe('ch:abc:commands');
            expect(CacheKeys.emotes('abc')).toBe('ch:abc:emotes');
            expect(CacheKeys.roles('abc', 'u1')).toBe('ch:abc:roles:u1');
        });

        it('gives two channels disjoint keys', () => {
            // The mechanical basis of cache-layer tenant isolation.
            expect(CacheKeys.commands('a')).not.toBe(CacheKeys.commands('b'));
        });
    });

    describe('happy path', () => {
        it('round-trips JSON', async () => {
            client.get.mockResolvedValue(JSON.stringify({ hello: 'world' }));

            await expect(cache.getJson('k')).resolves.toEqual({ hello: 'world' });
        });

        it('writes JSON with a TTL', async () => {
            await expect(cache.setJson('k', { a: 1 }, 60)).resolves.toBe(true);

            expect(client.set).toHaveBeenCalledWith('k', JSON.stringify({ a: 1 }), 'EX', 60);
        });

        it('reports a hash field hit', async () => {
            client.hget.mockResolvedValue(JSON.stringify('value'));

            await expect(cache.getHashField('k', 'f')).resolves.toEqual({ hit: true, value: 'value' });
        });
    });

    describe('the populated-miss distinction', () => {
        it('reports an authoritative miss when the hash exists', async () => {
            client.hget.mockResolvedValue(null);
            client.exists.mockResolvedValue(1);

            // "We have the whole set cached and this is not in it" - so the caller
            // can skip the database entirely.
            await expect(cache.getHashField('k', 'f')).resolves.toEqual({ hit: false, populated: true });
        });

        it('reports a non-authoritative miss when nothing is cached', async () => {
            client.hget.mockResolvedValue(null);
            client.exists.mockResolvedValue(0);

            await expect(cache.getHashField('k', 'f')).resolves.toEqual({ hit: false, populated: false });
        });

        it('uses EXISTS, never a full hash fetch, to decide', async () => {
            client.hget.mockResolvedValue(null);
            await cache.getHashField('k', 'f');

            // Phase 0 WP-7 trim (a): every non-matching chat message used to pay
            // for pulling the entire hash back.
            expect(client.exists).toHaveBeenCalledWith('k');
            expect((client as unknown as { hgetall?: unknown }).hgetall).toBeUndefined();
        });

        it('leaves a tombstone so an empty set still reads as populated', async () => {
            await cache.replaceHash('k', {}, 60);

            // Without this, an empty command list would look like "nothing cached"
            // and hit the database on every single message forever.
            expect(pipeline.hset).toHaveBeenCalledWith('k', '__empty__', 'true');
        });
    });

    describe('Redis unavailable - fallback mode', () => {
        beforeEach(() => {
            available = false;
        });

        it('reads report a miss rather than throwing', async () => {
            await expect(cache.getJson('k')).resolves.toBeNull();
            await expect(cache.getHashField('k', 'f')).resolves.toEqual({ hit: false, populated: false });
        });

        it('writes report failure rather than throwing', async () => {
            await expect(cache.setJson('k', {}, 60)).resolves.toBe(false);
            await expect(cache.replaceHash('k', { a: 1 }, 60)).resolves.toBe(false);
            await expect(cache.del('k')).resolves.toBe(false);
        });

        it('never touches the client at all', async () => {
            await cache.getJson('k');
            await cache.setJson('k', {}, 60);

            expect(client.get).not.toHaveBeenCalled();
            expect(client.set).not.toHaveBeenCalled();
        });
    });

    describe('Redis erroring - still fallback mode', () => {
        it('treats a failing read as a miss', async () => {
            client.get.mockRejectedValue(new Error('ECONNRESET'));

            await expect(cache.getJson('k')).resolves.toBeNull();
        });

        it('treats a failing hash read as a NON-authoritative miss', async () => {
            client.hget.mockRejectedValue(new Error('ECONNRESET'));

            // Crucially populated:false, so the caller falls back to the database
            // instead of concluding the command does not exist.
            await expect(cache.getHashField('k', 'f')).resolves.toEqual({ hit: false, populated: false });
        });

        it('treats unparseable cached JSON as a miss', async () => {
            client.get.mockResolvedValue('not json');

            await expect(cache.getJson('k')).resolves.toBeNull();
        });

        it('survives a failing write', async () => {
            client.set.mockRejectedValue(new Error('OOM'));

            await expect(cache.setJson('k', {}, 60)).resolves.toBe(false);
        });

        it('survives a failing delete', async () => {
            client.del.mockRejectedValue(new Error('nope'));

            await expect(cache.del('k')).resolves.toBe(false);
        });
    });

    describe('del', () => {
        it('is a no-op with no keys', async () => {
            await expect(cache.del()).resolves.toBe(false);
            expect(client.del).not.toHaveBeenCalled();
        });
    });
});
