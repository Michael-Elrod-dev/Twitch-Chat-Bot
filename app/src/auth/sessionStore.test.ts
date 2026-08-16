import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import {
    browserSessionStorage,
    memorySessionStorage,
    refreshSession,
    signOut,
    withFreshSession
} from './sessionStore.js';

/** A fetch that answers the API envelope, so the client under test is real. */
const jsonFetch = (status: number, body: unknown): typeof fetch =>
    vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;

describe('browserSessionStorage', () => {
    const store = (): Storage => {
        const map = new Map<string, string>();
        return {
            getItem: (k) => map.get(k) ?? null,
            setItem: (k, v) => { map.set(k, v); },
            removeItem: (k) => { map.delete(k); },
            clear: () => { map.clear(); },
            key: () => null,
            length: 0
        } as Storage;
    };

    it('round-trips a session', () => {
        const storage = browserSessionStorage(store());
        storage.write({ accessToken: 'at', refreshToken: 'rt' });

        expect(storage.read()).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    });

    it('reads nothing when nothing was written', () => {
        expect(browserSessionStorage(store()).read()).toBeNull();
    });

    it('treats corrupt storage as no session rather than crashing on boot', () => {
        const backing = store();
        backing.setItem('almosthadai.session', '{not json');

        expect(browserSessionStorage(backing).read()).toBeNull();
    });

    it('rejects a half-written session', () => {
        const backing = store();
        backing.setItem('almosthadai.session', JSON.stringify({ accessToken: 'at' }));

        expect(browserSessionStorage(backing).read()).toBeNull();
    });

    it('clears', () => {
        const storage = browserSessionStorage(store());
        storage.write({ accessToken: 'at', refreshToken: 'rt' });
        storage.clear();

        expect(storage.read()).toBeNull();
    });
});

describe('refreshSession', () => {
    it('returns the rotated pair', async () => {
        const fetchImpl = jsonFetch(200, {
            ok: true,
            data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 900 }
        });

        expect(await refreshSession('rt1', fetchImpl)).toEqual({
            accessToken: 'at2',
            refreshToken: 'rt2'
        });
    });

    it('surfaces a rejected refresh token', async () => {
        const fetchImpl = jsonFetch(401, {
            ok: false, error: { code: 'unauthorized', message: 'Refresh token is not valid' }
        });

        await expect(refreshSession('rt1', fetchImpl)).rejects.toThrow(ApiError);
    });
});

describe('signOut', () => {
    it('clears local state', async () => {
        const storage = memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' });
        await signOut(storage, jsonFetch(204, {}));

        expect(storage.read()).toBeNull();
    });

    it('still signs out locally when the server cannot be reached', async () => {
        const storage = memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' });
        const failing = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;

        await signOut(storage, failing);

        // Pressing Sign out must end the session on this machine regardless.
        expect(storage.read()).toBeNull();
    });

    it('is a no-op with no session', async () => {
        const storage = memorySessionStorage(null);
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        await signOut(storage, fetchImpl);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('withFreshSession', () => {
    it('passes the current access token straight through', async () => {
        const storage = memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' });
        const seen: string[] = [];

        await withFreshSession(storage, async (token) => { seen.push(token); return 'ok'; });
        expect(seen).toEqual(['at']);
    });

    it('refreshes once on a 401 and retries with the new token', async () => {
        const storage = memorySessionStorage({ accessToken: 'stale', refreshToken: 'rt' });
        const fetchImpl = jsonFetch(200, {
            ok: true, data: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 900 }
        });

        const seen: string[] = [];
        const result = await withFreshSession(storage, async (token) => {
            seen.push(token);
            if (token === 'stale') throw new ApiError('unauthorized', 'Token is not valid');
            return 'ok';
        }, fetchImpl);

        expect(result).toBe('ok');
        expect(seen).toEqual(['stale', 'fresh']);
        // The rotated refresh token must be stored, or the next refresh fails.
        expect(storage.read()).toEqual({ accessToken: 'fresh', refreshToken: 'rt2' });
    });

    it('does not loop when the refreshed token is also rejected', async () => {
        const storage = memorySessionStorage({ accessToken: 'stale', refreshToken: 'rt' });
        const fetchImpl = jsonFetch(200, {
            ok: true, data: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 900 }
        });

        let calls = 0;
        await expect(withFreshSession(storage, async () => {
            calls += 1;
            throw new ApiError('unauthorized', 'Token is not valid');
        }, fetchImpl)).rejects.toThrow(ApiError);

        expect(calls).toBe(2);
    });

    it('does not refresh on a non-auth failure', async () => {
        const storage = memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' });
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        await expect(withFreshSession(storage, async () => {
            throw new ApiError('unavailable', 'We cannot reach our server');
        }, fetchImpl)).rejects.toThrow('We cannot reach our server');

        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses when there is no session at all', async () => {
        await expect(withFreshSession(memorySessionStorage(null), async () => 'x'))
            .rejects.toThrow('Not signed in');
    });
});
