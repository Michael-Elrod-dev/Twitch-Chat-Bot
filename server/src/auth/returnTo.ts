/**
 * Where sign-in is allowed to hand the session back to.
 *
 * The completed sign-in redirects with a live access token and refresh token in
 * the URL fragment. An unvalidated `return_to` therefore hands a working session
 * to whatever host the query string names, for example
 *
 *   /auth/app/login?return_to=https://evil.example/steal
 *
 * A fragment is invisible to servers and absent from logs, which is why it
 * carries the handoff and also why an unchecked destination is a clean
 * exfiltration channel. The destination must be validated here, always.
 *
 * The rule is an allow-list, because a deny-list of "bad" hosts is unwinnable.
 * Two shapes are permitted and nothing else:
 *
 *  - The app's own scheme, `almosthadai://`. This is how the desktop client
 *    receives its session, because the OS hands the whole URL, fragment
 *    included, to the registered application. RFC 8252 sanctions a private-use
 *    scheme for native apps, and unlike a loopback HTTP listener it preserves
 *    the fragment, which a loopback server never sees because the browser keeps
 *    it.
 *  - Loopback origins, `http://127.0.0.1:*` and `http://localhost:*`, for
 *    development only, and only when `ALLOW_LOOPBACK_RETURN_TO` is set. Off in
 *    production, where nothing should be redirecting a session to a laptop.
 *
 * Anything else is refused at the point the flow starts, so the failure is a
 * clear 400 before Twitch is ever involved rather than a silent drop after.
 */

/** The desktop app's private-use URI scheme, registered by the Tauri shell. */
export const APP_URI_SCHEME = 'almosthadai';

export interface ReturnToPolicy {
    /** Development only. Never enable in production. */
    allowLoopback: boolean;
}

/**
 * @returns true when sign-in may hand a session to this destination.
 *
 * Deliberately total: every rejection path returns false rather than throwing,
 * so a malformed value is refused rather than turning into a 500.
 */
export function isAllowedReturnTo(value: string, policy: ReturnToPolicy): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        // Not a URL at all - including the protocol-relative `//evil.example`
        // that some naive checks let through.
        return false;
    }

    if (url.protocol === `${APP_URI_SCHEME}:`) return true;

    if (!policy.allowLoopback) return false;

    /*
     * Loopback by HOSTNAME, never by a substring of the URL. `http://
     * localhost.evil.example/` and `http://evil.example/?x=localhost` both
     * contain "localhost"; neither is loopback.
     */
    return url.protocol === 'http:'
        && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
}
