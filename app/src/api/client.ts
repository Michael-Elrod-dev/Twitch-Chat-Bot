import type { ApiErrorCode, ApiResponse } from '@almosthadai/shared';
import { API_BASE_URL } from './config.js';

/**
 * One way to reach the API, and one way to fail.
 *
 * The server answers every route with the same `{ ok, data | error }` envelope,
 * so the client parses one shape. Transport failures are folded into the same
 * error type with an `unavailable` code rather than thrown as a different
 * species of problem: the UI has to distinguish "the server said no" from "we
 * could not reach the server", and it does that on the code, not on whether an
 * exception escaped.
 */

export class ApiError extends Error {
    readonly code: ApiErrorCode;
    /** Present on 429, straight from `Retry-After`. */
    readonly retryAfterSeconds: number | null;

    constructor(
        code: ApiErrorCode,
        message: string,
        retryAfterSeconds: number | null = null,
        // Kept because the message here is deliberately user-facing and vague;
        // the underlying failure is what a developer needs, and dropping it
        // loses the only description of what actually went wrong.
        options?: { cause?: unknown }
    ) {
        super(message, options as ErrorOptions | undefined);
        this.name = 'ApiError';
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/**
 * The HTTP stack every call goes through.
 *
 * Swapped once at boot, for a reason worth stating: the Tauri webview loads
 * from `http://tauri.localhost`, so a `fetch` to the API is a cross-origin
 * request and the server sends no CORS headers, so every call would be blocked
 * by the browser engine before it left the machine.
 *
 * The fix is Tauri's HTTP plugin, which performs the request in Rust where no
 * origin policy applies. The alternative, teaching the server to send
 * `Access-Control-Allow-Origin`, would open the API to every web page a user
 * visits in order to serve a client that is not a web page at all. The narrower
 * change is the right one.
 *
 * WebSockets are unaffected: the handshake is not subject to CORS.
 */
let defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export function setDefaultFetch(impl: typeof fetch): void {
    defaultFetch = impl;
}

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** Bearer token. Omitted on the routes that have none yet (health). */
    accessToken?: string | undefined;
    signal?: AbortSignal | undefined;
    fetchImpl?: typeof fetch | undefined;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const doFetch = options.fetchImpl ?? defaultFetch;
    const headers: Record<string, string> = { accept: 'application/json' };

    if (options.accessToken) headers['authorization'] = `Bearer ${options.accessToken}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
        response = await doFetch(`${API_BASE_URL}${path}`, {
            method: options.method ?? 'GET',
            headers,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            ...(options.signal ? { signal: options.signal } : {})
        });
    } catch (cause) {
        // Not reaching the server is a first-class state, not an exception the
        // UI has to guess at. `4b` depends on telling this apart from a channel
        // that is merely offline.
        throw new ApiError('unavailable', 'We cannot reach our server', null, { cause });
    }

    if (response.status === 204) return undefined as T;

    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;

    let payload: ApiResponse<T>;
    try {
        payload = await response.json() as ApiResponse<T>;
    } catch (cause) {
        // A non-envelope body from something in front of the server (a proxy
        // error page, say) is still a failure the UI can render.
        throw new ApiError(
            'internal',
            `Server returned an unreadable response (${response.status})`,
            retryAfterSeconds,
            { cause }
        );
    }

    if (!payload.ok) {
        throw new ApiError(payload.error.code, payload.error.message, retryAfterSeconds);
    }

    return payload.data;
}

/**
 * Is the server there at all?
 *
 * Used by the sign-in screen's reachability pill, which is the first place a
 * user would hit an unreachable server. Deliberately returns a boolean rather
 * than throwing: "no" is the answer, not an error.
 */
export async function pingServer(fetchImpl?: typeof fetch): Promise<boolean> {
    const doFetch = fetchImpl ?? defaultFetch;
    try {
        const response = await doFetch(`${API_BASE_URL}/healthz`, { method: 'GET' });
        return response.ok;
    } catch {
        return false;
    }
}
