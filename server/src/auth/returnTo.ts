/**
 * Where sign-in is allowed to hand the session back to.
 *
 * ## The vulnerability this closes
 *
 * `return_to` was taken from the query string unvalidated, stored in the OAuth
 * state, and then used verbatim in `res.redirect()` **with a live access token
 * and refresh token in the fragment**. So:
 *
 *   /auth/app/login?return_to=https://evil.example/steal
 *
 * sent any user who completed sign-in to the attacker's page with a working
 * session in `location.hash`. A fragment is invisible to servers and absent
 * from logs, which is exactly why it was chosen for the handoff — and exactly
 * what makes it a clean exfiltration channel when the destination is not
 * checked. Found during P1-WP8 while finalising the desktop handoff; it was
 * live in production.
 *
 * ## The rule
 *
 * An allow-list, because a deny-list of "bad" hosts is unwinnable. Two shapes
 * are permitted and nothing else:
 *
 *  - **The app's own scheme** — `almosthadai://…`. This is how the desktop
 *    client receives its session: the OS hands the whole URL, fragment
 *    included, to the registered application. RFC 8252 sanctions a private-use
 *    scheme for native apps, and unlike a loopback HTTP listener it preserves
 *    the fragment (a loopback server never sees one — the browser keeps it).
 *  - **Loopback origins** — `http://127.0.0.1:*` / `http://localhost:*`, for
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
