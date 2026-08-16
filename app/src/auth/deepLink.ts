import { APP_RETURN_TO } from '../api/config.js';

/**
 * Receiving the session from the browser.
 *
 * Sign-in happens in the system browser (RFC 8252 — never an embedded webview,
 * which would put the app between the user and Twitch's password field). The
 * server redirects to `almosthadai://auth#access_token=…&refresh_token=…`, and
 * Windows hands that whole URL to the registered application.
 *
 * The fragment is what carries the tokens, deliberately: a fragment is never
 * sent to a server, so it appears in no access log and no `Referer`. The
 * server-side allow-list is what makes that safe — an unchecked `return_to`
 * turned exactly this mechanism into an exfiltration channel once already.
 */

export interface AuthCallback {
    accessToken: string;
    refreshToken: string;
    /** The value the app put in `return_to` when it started this sign-in. */
    nonce: string | null;
}

/**
 * The `return_to` for one sign-in attempt.
 *
 * Carries a single-use nonce. Any local program can invoke a registered URI
 * scheme, so without this a hostile process on the same machine could hand the
 * app a session belonging to an account it controls and quietly watch the
 * broadcaster operate the wrong channel. Matching the nonce against the one
 * this app generated means only a callback we started can be accepted.
 *
 * The scheme is all the server's allow-list checks, so the query rides along
 * untouched and comes back verbatim.
 */
export function returnToWithNonce(nonce: string): string {
    return `${APP_RETURN_TO}?n=${encodeURIComponent(nonce)}`;
}

export function generateNonce(crypto: Crypto = globalThis.crypto): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parses a deep-link URL into a session, or null if it is not one.
 *
 * Total by design: a malformed or unrelated URL is "not a callback", never an
 * exception. The OS will hand this function whatever anyone registers against
 * the scheme, so it treats its input as hostile.
 */
export function parseAuthCallback(url: string): AuthCallback | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'almosthadai:') return null;

    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) return null;

    const fragment = new URLSearchParams(url.slice(hashIndex + 1));
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');

    // Both or neither: half a session is not a session.
    if (!accessToken || !refreshToken) return null;

    return {
        accessToken,
        refreshToken,
        nonce: parsed.searchParams.get('n')
    };
}
