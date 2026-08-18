import type { CacheManager } from './cacheManager.js';

/**
 * A cache that actually caches.
 *
 * Every cache double in the suite until now returned a miss for everything,
 * which is the right shape for testing "does this code survive a cold Redis"
 * and precisely the wrong shape for testing "does a write invalidate what a
 * reader already holds". Against a null cache a stale-read bug is unreachable:
 * the read falls through to the database and the test passes over the defect.
 *
 * So this stores what it is given, in a Map, and returns it again, which is
 * Redis's observable behavior for the operations in use here.
 *
 * **TTLs are recorded and never enforced.** Time does not pass inside a test,
 * and the interesting window is the one *before* expiry: a value that has aged
 * out is a value the reader would have re-fetched anyway. Modelling the clock
 * would only let a slow test pass for the wrong reason.
 */
export class MapCache {
    private readonly values = new Map<string, string>();
    private readonly hashes = new Map<string, Map<string, string>>();
    /** Exposed so a test can assert what TTL a caller asked for. */
    readonly ttls = new Map<string, number>();

    async getJson<T>(key: string): Promise<T | null> {
        const raw = this.values.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
    }

    async setJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
        this.values.set(key, JSON.stringify(value));
        this.ttls.set(key, ttlSeconds);
        return true;
    }

    async del(...keys: string[]): Promise<boolean> {
        for (const key of keys) {
            this.values.delete(key);
            this.hashes.delete(key);
            this.ttls.delete(key);
        }
        return true;
    }

    async getHashField<T>(
        key: string,
        field: string
    ): Promise<{ hit: true; value: T } | { hit: false; populated: boolean }> {
        const hash = this.hashes.get(key);
        if (!hash) return { hit: false, populated: false };

        const raw = hash.get(field);
        // The three-state answer, including the one that made the commands hole
        // permanent: the hash exists, so an absent field is an authoritative
        // "no such command" rather than "nothing cached".
        if (raw === undefined) return { hit: false, populated: true };
        return { hit: true, value: JSON.parse(raw) as T };
    }

    async replaceHash(key: string, values: Record<string, unknown>, ttlSeconds: number): Promise<boolean> {
        const hash = new Map<string, string>();
        for (const [field, value] of Object.entries(values)) {
            hash.set(field, JSON.stringify(value));
        }
        this.hashes.set(key, hash);
        this.ttls.set(key, ttlSeconds);
        return true;
    }

    /** Whether a key is currently held. For asserting an invalidation happened. */
    has(key: string): boolean {
        return this.values.has(key) || this.hashes.has(key);
    }
}

/**
 * `CacheManager` carries private fields, so a structurally identical class is
 * not assignable to it. The cast is confined to this one function rather than
 * repeated at every call site.
 */
export const asCacheManager = (cache: MapCache): CacheManager => cache as unknown as CacheManager;

/**
 * A cache that never holds anything. Every read is a miss and every write is
 * discarded. This is what a suite wants when the cache is scaffolding rather
 * than the subject, so reads fall through to the database and assertions are
 * about the data, not about staleness.
 *
 * Exported rather than shared by default. It is opt-in per call site precisely
 * so it cannot quietly change what a test that did not ask for it observes.
 */
export const nullCache = (): CacheManager =>
    ({
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true,
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true
    }) as unknown as CacheManager;
