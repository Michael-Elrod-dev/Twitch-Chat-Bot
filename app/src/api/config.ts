/**
 * Where the server lives.
 *
 * A build-time constant rather than a server env var: the desktop client is
 * shipped as a binary and never reads the server's environment, so this
 * deliberately does NOT belong in the zod env schema or the compose passthrough
 * that server-side variables do. It is documented in `app/.env.example`.
 *
 * The default is the local dev server, so a developer who has set nothing gets
 * the thing they almost certainly meant.
 */
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';

export const API_BASE_URL: string =
    (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? DEFAULT_API_BASE_URL;

/**
 * The redirect the sign-in flow hands back to.
 *
 * A private-use URI scheme (RFC 8252). The server allow-lists exactly this
 * shape — the open-redirect fix in the auth-foundation package is what makes
 * sending a `return_to` at all safe, and an app that sent anything else would
 * simply be refused with a 400.
 */
export const APP_RETURN_TO = 'almosthadai://auth';

/**
 * The app's own version — the auth screens' bottom line and the account
 * screen's `Version …` row.
 *
 * `__APP_VERSION__` is defined by the Vite config from `package.json`, so this
 * cannot disagree with the build it ships in. It used to be a hand-typed
 * `'v0.1.0'`, which is the sort of string that survives every release after the
 * one it was written for — and a version the app reports wrongly is worse than
 * none, because a bug report would name a build that never existed.
 *
 * The fallback covers a consumer that has not run through Vite's `define`, which
 * is nothing we ship but is exactly what a bare `tsc` or a stray test runner is.
 */
declare const __APP_VERSION__: string | undefined;

/** `0.1.0` — the bare number, for anywhere the word "Version" precedes it. */
export const APP_VERSION_NUMBER: string =
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * `v0.1.0` — the prefixed form the auth screens print on their own.
 *
 * Two exports rather than a `replace(/^v/, '')` at the one call site that does
 * not want the letter: the account row reads "Version 0.1.0", and "Version
 * v0.1.0" is the kind of thing that ships because nobody read the rendered
 * string. Derived from the same constant, so they cannot disagree.
 */
export const APP_VERSION = `v${APP_VERSION_NUMBER}`;
