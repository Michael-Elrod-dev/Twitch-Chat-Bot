import { apiRequest, ApiError } from '../api/client.js';

/**
 * The signed-in session, and how it is kept.
 *
 * Tokens are never logged, never put in a URL the app constructs, and never
 * rendered. The only place they are written is the store below.
 *
 * Where they live, and the honest limitation. They are held in `localStorage`
 * inside the Tauri webview. That webview loads only bundled local content, with
 * no remote origin and no third-party script, so the usual XSS path to
 * `localStorage` does not exist here. It is still weaker than the
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
        // Intentionally swallowed, for the reason above.
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

/**
 * How close to expiry a token has to be before it is replaced up front.
 *
 * A WebSocket authenticates once, at the upgrade, and a handshake that starts
 * with sixty seconds left would be racing the clock for no reason.
 */
const REFRESH_MARGIN_SECONDS = 60;

/**
 * @returns the access token's expiry in epoch seconds, or null if it cannot be
 * read.
 *
 * These are our own tokens, so the payload is ours to read; a token we cannot
 * parse is treated as expired rather than trusted, which fails towards a
 * refresh instead of towards a rejected connection.
 */
function expiryOf(accessToken: string): number | null {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;

    try {
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const exp = (JSON.parse(json) as { exp?: unknown }).exp;
        return typeof exp === 'number' ? exp : null;
    } catch {
        return null;
    }
}

/**
 * An access token that will still be valid when it is used.
 *
 * **This exists because the realtime connection cannot ask for one lazily.**
 * `withFreshSession` refreshes in reaction to a 401, which works for HTTP where
 * the rejection is visible. A browser WebSocket does not expose the handshake's
 * status code, because a rejected upgrade arrives as an ordinary close, so a
 * socket reconnecting with a stale token retries forever and never learns why.
 *
 * That is not hypothetical. Access tokens live fifteen minutes, so a shell that
 * captured one at boot and reused it for every reconnect would find any drop
 * after the first fifteen minutes (a deploy, a blip, a closed laptop lid) left
 * the dashboard permanently unable to reconnect, showing "we cannot reach our
 * server" over a server that was perfectly healthy. Found on the owner's own
 * machine, in exactly that state, after a redeploy.
 *
 * Checking expiry BEFORE connecting is what makes the reconnect loop able to
 * heal itself.
 */
export async function freshAccessToken(
    storage: SessionStorage,
    fetchImpl?: typeof fetch,
    now: () => number = Date.now
): Promise<string> {
    const session = storage.read();
    if (!session) throw new ApiError('unauthorized', 'Not signed in');

    const expiry = expiryOf(session.accessToken);
    const stillGood = expiry !== null
        && expiry - REFRESH_MARGIN_SECONDS > Math.floor(now() / 1000);
    if (stillGood) return session.accessToken;

    const rotated = await refreshSession(session.refreshToken, fetchImpl);
    storage.write(rotated);
    return rotated.accessToken;
}
