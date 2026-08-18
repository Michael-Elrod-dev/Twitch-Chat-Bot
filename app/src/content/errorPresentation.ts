import type { ApiErrorCode } from '@almosthadai/shared';
import { ApiError } from '../api/client.js';

/**
 * One presentation for the whole error envelope.
 *
 * The handoff is explicit that there is exactly one, and the reason is in its
 * last sentence: **never a full-page error wall over a working bot.** Every
 * failure the API can report is a small thing that happened to one request, and
 * the screen behind it is still true. So this decides only *where* a message
 * goes, and nothing anywhere decides to stop rendering.
 *
 * Placement, and why each is where it is:
 *
 * - field, for `bad_request` and `conflict`. The user typed something the
 *   server refused, so the message belongs next to what they typed. A banner
 *   for "that name is taken" would make them hunt for which of two fields is
 *   wrong.
 * - inline, for `rate_limited`. Deliberately not a banner, because being asked
 *   to wait nine seconds is not an error state, and dressing it as one teaches
 *   people their bot is broken when it is merely busy. Carries `Retry-After` so
 *   the line can say how long rather than "try again later".
 * - banner, for everything else. `unauthorized`, `unavailable`, `internal`,
 *   `forbidden` and transport failure are all conditions the user did not cause
 *   and cannot fix by editing a field.
 *
 * `not_found` is a banner too, with one deliberate exception handled by the
 * callers rather than here: deleting something that is already gone has reached
 * the state the user asked for, and reporting it would be pedantry.
 */

export type ErrorPlacement = 'field' | 'inline' | 'banner';

export interface PresentedError {
    placement: ErrorPlacement;
    /** The server's own message where there is one, written for humans. */
    message: string;
    /** Seconds from `Retry-After`, on `rate_limited` only. */
    retryAfterSeconds: number | null;
    /** Kept so callers can special-case without re-inspecting the error. */
    code: ApiErrorCode | 'transport';
}

const FIELD_CODES: ReadonlySet<string> = new Set<ApiErrorCode>(['bad_request', 'conflict']);

export function presentError(error: unknown): PresentedError {
    if (!(error instanceof ApiError)) {
        /*
         * Not one of ours. `apiRequest` already folds transport failures into
         * `ApiError('unavailable')`, so reaching here means a genuine bug in the
         * client, which the user still should not be shown a stack trace for.
         */
        return {
            placement: 'banner',
            message: 'Something went wrong',
            retryAfterSeconds: null,
            code: 'transport'
        };
    }

    if (error.code === 'rate_limited') {
        return {
            placement: 'inline',
            message: error.retryAfterSeconds === null
                ? 'Too many changes at once. Give it a moment.'
                : `Too many changes at once. Try again in ${error.retryAfterSeconds}s.`,
            retryAfterSeconds: error.retryAfterSeconds,
            code: error.code
        };
    }

    return {
        placement: FIELD_CODES.has(error.code) ? 'field' : 'banner',
        message: error.message,
        retryAfterSeconds: null,
        code: error.code
    };
}

/** True when a delete failed only because the thing was already gone. */
export function isAlreadyGone(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'not_found';
}
