import type { Redis } from 'ioredis';
import type { Logger } from '../logger.js';
import type { RedisHandle } from './redis.js';

/**
 * Channel-scoped cache with a hard guarantee: **every method degrades to a
 * cache miss when Redis is unavailable, and never throws.**
 *
 * Phase 0 established that Redis is optional infrastructure. Callers are written
 * as "ask the cache, fall back to the database" and must never need a try/catch
 * around a cache read — if that discipline slips, a Redis blip becomes an outage.
 */
export class CacheManager {
    private readonly redis: RedisHandle;
    private readonly logger: Logger;

    constructor(redis: RedisHandle, logger: Logger) {
        this.redis = redis;
        this.logger = logger;
    }

    private client(): Redis | null {
        return this.redis.isAvailable() ? this.redis.client : null;
    }

    /** @returns the parsed value, or null on a miss OR any failure. */
    async getJson<T>(key: string): Promise<T | null> {
        const client = this.client();
        if (!client) return null;

        try {
            const raw = await client.get(key);
            if (raw === null) return null;
            return JSON.parse(raw) as T;
        } catch (err) {
            this.logger.warn({ key, err: (err as Error).message }, 'Cache read failed - treating as miss');
            return null;
        }
    }

    /** @returns whether the value was stored. A false is never worth failing a request over. */
    async setJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
        const client = this.client();
        if (!client) return false;

        try {
            await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
            return true;
        } catch (err) {
            this.logger.warn({ key, err: (err as Error).message }, 'Cache write failed');
            return false;
        }
    }

    async del(...keys: string[]): Promise<boolean> {
        const client = this.client();
        if (!client || keys.length === 0) return false;

        try {
            await client.del(...keys);
            return true;
        } catch (err) {
            this.logger.warn({ keys, err: (err as Error).message }, 'Cache delete failed');
            return false;
        }
    }

    /**
     * Reads one field of a cached hash.
     *
     * The three-state return is the point. Phase 0's WP-7 trim replaced a
     * `hget` + full `hgetall` on every non-matching chat message with an O(1)
     * existence check; distinguishing "the hash is populated and this field is
     * genuinely absent" from "we have nothing cached" is what lets a miss avoid
     * a database round-trip.
     *
     * @returns `{ hit: true, value }` on a hit, `{ hit: false, populated: true }`
     * when the hash exists but lacks the field, and `{ hit: false, populated: false }`
     * when there is no cache to consult.
     */
    async getHashField<T>(
        key: string,
        field: string
    ): Promise<{ hit: true; value: T } | { hit: false; populated: boolean }> {
        const client = this.client();
        if (!client) return { hit: false, populated: false };

        try {
            const raw = await client.hget(key, field);
            if (raw !== null) {
                return { hit: true, value: JSON.parse(raw) as T };
            }
            // O(1), unlike pulling the whole hash back merely to ask whether it
            // was populated.
            const exists = await client.exists(key);
            return { hit: false, populated: exists === 1 };
        } catch (err) {
            this.logger.warn({ key, field, err: (err as Error).message }, 'Cache hash read failed - treating as miss');
            return { hit: false, populated: false };
        }
    }

    /** Replaces a hash wholesale. An empty record leaves a tombstone so misses stay cheap. */
    async replaceHash(key: string, values: Record<string, unknown>, ttlSeconds: number): Promise<boolean> {
        const client = this.client();
        if (!client) return false;

        try {
            const pipeline = client.multi();
            pipeline.del(key);

            const entries = Object.entries(values);
            if (entries.length > 0) {
                pipeline.hset(key, ...entries.flatMap(([f, v]) => [f, JSON.stringify(v)]));
            } else {
                // Without this the key would not exist, and every miss would look
                // like "nothing cached" and hit the database forever.
                pipeline.hset(key, '__empty__', 'true');
            }

            pipeline.expire(key, ttlSeconds);
            await pipeline.exec();
            return true;
        } catch (err) {
            this.logger.warn({ key, err: (err as Error).message }, 'Cache hash write failed');
            return false;
        }
    }
}
