import { apiRequest, ApiError } from '../api/client.js';

/**
 * The signed-in session, and how it is kept.
 *
 * Tokens are never logged, never put in a URL the app constructs, and never
 * rendered. The only place they are written is the store below.
 *
 * **Where they live, and the honest limitation.** They are held in
 * `localStorage` inside the Tauri webview. That webview loads only bundled
 * local content — no remote origin, no third-party script — so the usual XSS
 * path to `localStorage` does not exist here. It is still weaker than the
 * Windows credential store, which survives nothing-in-particular better but
 * does resist another process reading the profile directory. The storage is
 * behind `SessionStorage` precisely so that swap is one implementation, not a
 * refactor; it is recorded as follow-up work rather than pretended away.
 */

export interface StoredSession {
    accessToken: string;
    refreshToken: string;
}

export interface SessionStorage {
    read: () => StoredSession | null;
    write: (session: StoredSession) => void;
    clear: () => void;
}

const STORAGE_KEY = 'almosthadai.session';

export function browserSessionStorage(store: Storage = localStorage): SessionStorage {
    return {
        read: () => {
            const raw = store.getItem(STORAGE_KEY);
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw) as Partial<StoredSession>;
                if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
                    return null;
                }
                return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
            } catch {
                // Corrupt storage is an absent session, not a crash on startup.
                return null;
            }
        },
        write: (session) => { store.setItem(STORAGE_KEY, JSON.stringify(session)); },
        clear: () => { store.removeItem(STORAGE_KEY); }
    };
}

/** In-memory, for tests and for a build that should not persist anything. */
export function memorySessionStorage(initial: StoredSession | null = null): SessionStorage {
    let current = initial;
    return {
        read: () => current,
        write: (session) => { current = session; },
        clear: () => { current = null; }
    };
}

export interface RefreshResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

/**
 * Exchanges the refresh token for a new pair.
 *
 * The server rotates on every use, so the new refresh token must be stored or
 * the session is lost at the next attempt.
 */
export async function refreshSession(
    refreshToken: string,
    fetchImpl?: typeof fetch
): Promise<StoredSession> {
    const data = await apiRequest<RefreshResponse>('/auth/app/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        fetchImpl
    });

    return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/**
 * Ends the session server-side, then locally.
 *
 * Local state is cleared even when the call fails: a user who pressed Sign out
 * on an unreachable server must still end up signed out on this machine, and
 * the refresh token is revoked by the next successful attempt or by expiry.
 */
export async function signOut(
    storage: SessionStorage,
    fetchImpl?: typeof fetch
): Promise<void> {
    const session = storage.read();
    try {
        if (session) {
            await apiRequest<void>('/auth/app/logout', {
                method: 'POST',
                body: { refresh_token: session.refreshToken },
                fetchImpl
            });
        }
    } catch {
        // Intentionally swallowed — see above.
    } finally {
        storage.clear();
    }
}

/**
 * Runs a request, refreshing once if the access token has expired.
 *
 * One retry, never a loop: if a freshly-minted token is also rejected, the
 * session is genuinely finished and retrying would only hammer the server on
 * the way to the same answer.
 */
export async function withFreshSession<T>(
    storage: SessionStorage,
    call: (accessToken: string) => Promise<T>,
    fetchImpl?: typeof fetch
): Promise<T> {
    const session = storage.read();
    if (!session) throw new ApiError('unauthorized', 'Not signed in');

    try {
        return await call(session.accessToken);
    } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'unauthorized') throw error;

        const rotated = await refreshSession(session.refreshToken, fetchImpl);
        storage.write(rotated);
        return await call(rotated.accessToken);
    }
}
