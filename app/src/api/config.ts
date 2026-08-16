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

/** The app's own version, shown bottom-centre on the auth screens. */
export const APP_VERSION = 'v0.1.0';
