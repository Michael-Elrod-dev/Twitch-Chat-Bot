import { randomBytes } from 'node:crypto';
import type { CacheManager } from '../cache/cacheManager.js';
import type { OAuthFlow } from '../twitch/oauth.js';

/**
 * OAuth `state` — the CSRF defence for the callback.
 *
 * Without it, anyone could send the owner a crafted callback URL carrying *their*
 * authorization code and silently attach their Twitch account to this server.
 * The value is issued here, stored, and must be presented back exactly once.
 *
 * Single-use is the property that matters: a replayed state is refused even if
 * it has not expired.
 */

const STATE_TTL_SECONDS = 600;
const STATE_BYTES = 32;

export interface StateRecord {
    flow: OAuthFlow;
    /** Where to send the browser afterwards, when the flow was started from the app. */
    returnTo?: string;
    createdAt: number;
}

export interface StateStore {
    issue: (flow: OAuthFlow, returnTo?: string) => Promise<string>;
    /** @returns the record and consumes it, or null when unknown, expired or replayed. */
    consume: (state: string) => Promise<StateRecord | null>;
}

/**
 * Redis-backed, with an in-process fallback.
 *
 * Redis is a cache and never a source of truth (house rule), but OAuth state is
 * genuinely ephemeral, so the fallback is a plain Map rather than the database.
 * The fallback is correct for a single process — which is what we run — and the
 * consequence of losing state is one retried consent screen.
 */
export function createStateStore(cache: CacheManager, memory = new Map<string, StateRecord>()): StateStore {
    const key = (state: string): string => `oauth:state:${state}`;

    return {
        issue: async (flow, returnTo) => {
            // 256 bits of CSPRNG. Guessing one is not a threat worth modelling.
            const state = randomBytes(STATE_BYTES).toString('base64url');
            const record: StateRecord = {
                flow,
                ...(returnTo === undefined ? {} : { returnTo }),
                createdAt: Date.now()
            };

            memory.set(state, record);
            await cache.setJson(key(state), record, STATE_TTL_SECONDS);

            return state;
        },

        consume: async (state) => {
            if (state === '') return null;

            const fromMemory = memory.get(state) ?? null;
            const fromCache = await cache.getJson<StateRecord>(key(state));

            // Deleted from both regardless of which one answered, so a state can
            // never be spent twice.
            memory.delete(state);
            await cache.del(key(state));

            const record = fromMemory ?? fromCache;
            if (!record) return null;

            if (Date.now() - record.createdAt > STATE_TTL_SECONDS * 1000) return null;

            return record;
        }
    };
}
