/** Envelope every REST endpoint responds with, so the client has one shape to parse. */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ApiSuccess<T> {
    ok: true;
    data: T;
}

export interface ApiFailure {
    ok: false;
    error: {
        /** Stable machine-readable code - the client switches on this, never on the message. */
        code: ApiErrorCode;
        /** Human-readable, safe to surface in the UI. Never contains secrets or stack traces. */
        message: string;
    };
}

export const API_ERROR_CODES = [
    'bad_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'internal'
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Current API version prefix. Bumped only on a breaking contract change. */
export const API_VERSION = 'v1' as const;

export function apiSuccess<T>(data: T): ApiSuccess<T> {
    return { ok: true, data };
}

export function apiFailure(code: ApiErrorCode, message: string): ApiFailure {
    return { ok: false, error: { code, message } };
}
