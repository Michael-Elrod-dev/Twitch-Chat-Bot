import { describe, it, expect, vi } from 'vitest';
import { createStateStore, type StateRecord } from './stateStore.js';
import type { CacheManager } from '../cache/cacheManager.js';

/** A cache that stores nothing, so these tests exercise the in-process path. */
const nullCache = (): CacheManager =>
    ({ getJson: async () => null, setJson: async () => true, del: async () => true }) as unknown as CacheManager;

describe('OAuth state store', () => {
    it('issues a state that can be consumed once', async () => {
        const store = createStateStore(nullCache());
        const state = await store.issue('channel');

        expect(await store.consume(state)).toMatchObject({ flow: 'channel' });
    });

    it('refuses a second use', async () => {
        // Single-use is the property that matters: a replayed state is refused
        // even when it has not expired.
        const store = createStateStore(nullCache());
        const state = await store.issue('channel');

        await store.consume(state);
        expect(await store.consume(state)).toBeNull();
    });

    it('refuses a state it never issued', async () => {
        expect(await createStateStore(nullCache()).consume('invented')).toBeNull();
        expect(await createStateStore(nullCache()).consume('')).toBeNull();
    });

    it('issues unguessable, distinct values', async () => {
        const store = createStateStore(nullCache());
        const values = await Promise.all(Array.from({ length: 100 }, () => store.issue('signin')));

        expect(new Set(values).size).toBe(100);
        expect((values[0] as string).length).toBeGreaterThan(32);
    });

    it('carries the flow and return address through', async () => {
        const store = createStateStore(nullCache());
        const state = await store.issue('signin', 'almosthadai://callback');

        expect(await store.consume(state)).toMatchObject({
            flow: 'signin', returnTo: 'almosthadai://callback'
        });
    });

    it('refuses an expired state', async () => {
        const memory = new Map<string, StateRecord>();
        const store = createStateStore(nullCache(), memory);
        const state = await store.issue('channel');

        // Age it past the ten-minute window.
        const record = memory.get(state) as StateRecord;
        memory.set(state, { ...record, createdAt: Date.now() - 11 * 60_000 });

        expect(await store.consume(state)).toBeNull();
    });

    it('clears the cache entry even when memory answered', async () => {
        // Both stores must forget it, or the state is spendable twice across a
        // restart.
        const del = vi.fn(async () => true);
        const cache = { getJson: async () => null, setJson: async () => true, del } as unknown as CacheManager;
        const store = createStateStore(cache);

        await store.consume(await store.issue('channel'));

        expect(del).toHaveBeenCalled();
    });

    it('survives a Redis that is down', async () => {
        // The house rule: a Redis outage degrades performance and nothing else.
        const broken = {
            getJson: async () => null,
            setJson: async () => false,
            del: async () => false
        } as unknown as CacheManager;
        const store = createStateStore(broken);

        const state = await store.issue('channel');
        expect(await store.consume(state)).toMatchObject({ flow: 'channel' });
    });

    it('recovers a state from the cache when memory has lost it', async () => {
        const record: StateRecord = { flow: 'bot', createdAt: Date.now() };
        const cache = {
            getJson: async () => record,
            setJson: async () => true,
            del: async () => true
        } as unknown as CacheManager;

        expect(await createStateStore(cache).consume('some-state')).toMatchObject({ flow: 'bot' });
    });
});
