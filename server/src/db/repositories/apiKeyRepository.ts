import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { apiKeys } from '../schema/channels.js';

/**
 * Stream Deck API keys.
 *
 * Same discipline as app refresh tokens: the key is 256 bits of CSPRNG, only
 * its hash is stored, and lookup happens *by* hash so no method ever holds a
 * usable key longer than the call it was handed one in.
 *
 * A key is shown exactly once, at creation. There is no recovery path, because
 * a recoverable credential is a stored credential.
 */

/** Identifies our keys on sight, in a log or pasted into the wrong field. */
const KEY_PREFIX = 'ahai_';
const PREFIX_DISPLAY_LENGTH = KEY_PREFIX.length + 6;

export interface ApiKeyRecord {
    id: string;
    channelId: string;
    name: string;
    prefix: string;
    lastUsedAt: Date | null;
    createdAt: Date;
}

export interface CreatedApiKeyRecord extends ApiKeyRecord {
    /** Returned once and never again. */
    key: string;
}

export function hashApiKey(key: string): string {
    // Keyless HMAC: the key is already high-entropy random, so there is nothing
    // to brute-force and no need for a slow KDF.
    return createHmac('sha256', 'almosthadai-api-key').update(key).digest('base64url');
}

export class ApiKeyRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async listFor(channelId: string): Promise<ApiKeyRecord[]> {
        return this.db
            .select({
                id: apiKeys.id,
                channelId: apiKeys.channelId,
                name: apiKeys.name,
                prefix: apiKeys.prefix,
                lastUsedAt: apiKeys.lastUsedAt,
                createdAt: apiKeys.createdAt
            })
            .from(apiKeys)
            .where(eq(apiKeys.channelId, channelId));
    }

    async create(channelId: string, name: string): Promise<CreatedApiKeyRecord> {
        const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
        const prefix = key.slice(0, PREFIX_DISPLAY_LENGTH);

        const [row] = await this.db
            .insert(apiKeys)
            .values({ channelId, name, keyHash: hashApiKey(key), prefix })
            .returning({
                id: apiKeys.id,
                channelId: apiKeys.channelId,
                name: apiKeys.name,
                prefix: apiKeys.prefix,
                lastUsedAt: apiKeys.lastUsedAt,
                createdAt: apiKeys.createdAt
            });

        if (!row) throw new Error('api key insert returned no row');
        return { ...row, key };
    }

    /** @returns the key's record, or null when it is unknown. */
    async resolve(presented: string): Promise<ApiKeyRecord | null> {
        // Cheap structural rejection before touching the database: anything
        // without our prefix cannot be one of our keys.
        if (!presented.startsWith(KEY_PREFIX)) return null;

        const [row] = await this.db
            .select({
                id: apiKeys.id,
                channelId: apiKeys.channelId,
                name: apiKeys.name,
                prefix: apiKeys.prefix,
                keyHash: apiKeys.keyHash,
                lastUsedAt: apiKeys.lastUsedAt,
                createdAt: apiKeys.createdAt
            })
            .from(apiKeys)
            .where(eq(apiKeys.keyHash, hashApiKey(presented)));

        if (!row) return null;

        // The lookup already matched on the hash, so this is belt and braces
        // against a future change that widens the query.
        const expected = Buffer.from(row.keyHash, 'utf8');
        const actual = Buffer.from(hashApiKey(presented), 'utf8');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

        return {
            id: row.id,
            channelId: row.channelId,
            name: row.name,
            prefix: row.prefix,
            lastUsedAt: row.lastUsedAt,
            createdAt: row.createdAt
        };
    }

    /** Best-effort usage stamp; callers must not fail a request on it. */
    async touch(id: string): Promise<void> {
        await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
    }

    /** Scoped to the channel, so one tenant cannot revoke another's key by id. */
    async revoke(channelId: string, id: string): Promise<boolean> {
        const removed = await this.db
            .delete(apiKeys)
            .where(and(eq(apiKeys.id, id), eq(apiKeys.channelId, channelId)))
            .returning({ id: apiKeys.id });

        return removed.length > 0;
    }
}
