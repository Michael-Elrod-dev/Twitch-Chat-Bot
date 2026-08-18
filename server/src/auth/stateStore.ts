import { randomBytes } from 'node:crypto';
import type { CacheManager } from '../cache/cacheManager.js';
import type { OAuthFlow } from '../twitch/oauth.js';

/**
 * OAuth `state` — the CSRF defense for the callback.
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
    flow: OAuthFlow | 'spotify';
    /** Where to send the browser afterwards, when the flow was started from the app. */
    returnTo?: string;
    /**
     * A flow to continue into once this one completes.
     *
     * This is what makes `/auth/spotify/connect` work in a plain browser: an
     * unauthenticated visit chains through Twitch sign-in and continues to
     * Spotify, so a human never handles a token. Carried in the server-issued
     * state rather than a query parameter, so a caller cannot ask to be
     * forwarded somewhere of their choosing.
     */
    then?: 'spotify';
    createdAt: number;
}

export interface StateStore {
    issue: (flow: OAuthFlow | 'spotify', returnTo?: string, then?: 'spotify') => Promise<string>;
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
        issue: async (flow, returnTo, then) => {
            // 256 bits of CSPRNG. Guessing one is not a threat worth modelling.
            const state = randomBytes(STATE_BYTES).toString('base64url');
            const record: StateRecord = {
                flow,
                ...(returnTo === undefined ? {} : { returnTo }),
                ...(then === undefined ? {} : { then }),
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
