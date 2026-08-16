/**
 * How the usage counter is shown to a viewer.
 *
 * ## The regression this fixes
 *
 * Phase 0 suppressed the counter for broadcasters and for unlimited caps
 * (`aiManager.js:91`: `if (!userContext.isBroadcaster && userLimits.streamLimit
 * < 999999)`). The P1-WP4.1 port dropped that condition and prefixed every
 * answer unconditionally, so the owner watched their own bot reply `(2/999999)`
 * in their own chat.
 *
 * ## What replaces it (owner-requested, lead-ruled)
 *
 * A raw `used/limit` on every message is noise: it answers a question nobody
 * asked until the answer starts to matter. So the counter appears only when it
 * is actionable — when the viewer is nearly out:
 *
 *   remaining > 3   nothing at all
 *   remaining 1..3  `(2 left this stream)`
 *   remaining 0     `(last one this stream)`
 *   unlimited cap   nothing, ever
 *
 * Uniform across roles: a moderator near their cap needs the warning as much as
 * anyone. The broadcaster suppression Phase 0 special-cased falls out of the
 * unlimited rule instead of being a role check, which is the same outcome with
 * one fewer thing to keep in sync.
 *
 * Denial is untouched — running out is already its own message.
 *
 * **Future:** threshold and an always-on preference belong in `channel_settings`
 * for the app's AI settings screen, so a streamer who wants the old running
 * count can have it. Env-knobbed here so it can be tuned before that exists.
 */

/**
 * At or below this many remaining, the viewer is told.
 *
 * Absolute rather than proportional: "3 left" means the same thing to a viewer
 * on a cap of 5 and a moderator on 15, whereas a percentage would warn one of
 * them far too early.
 */
export const DEFAULT_COUNTER_THRESHOLD = 3;

/**
 * At or above this cap, the counter never appears.
 *
 * Phase 0 wrote the broadcaster's allowance as 999,999 — a number chosen to
 * mean "no limit". Any cap in that territory is unlimited in practice, and
 * counting down from it is meaningless.
 */
export const UNLIMITED_LIMIT = 1000;

export interface CounterOptions {
    /** Usage INCLUDING the request being answered. */
    used: number;
    limit: number;
    threshold?: number;
}

/**
 * @returns the suffix to append to an answer, or null when nothing should be
 * shown. Never a prefix: the answer is what the viewer asked for, and the
 * bookkeeping belongs after it.
 */
export function usageSuffix(options: CounterOptions): string | null {
    const { used, limit } = options;
    const threshold = options.threshold ?? DEFAULT_COUNTER_THRESHOLD;

    if (limit >= UNLIMITED_LIMIT) return null;

    const remaining = Math.max(0, limit - used);
    if (remaining > threshold) return null;

    return remaining === 0
        ? '(last one this stream)'
        : `(${remaining} left this stream)`;
}

/** Appends the suffix when there is one. */
export function withUsageSuffix(text: string, options: CounterOptions): string {
    const suffix = usageSuffix(options);
    return suffix === null ? text : `${text} ${suffix}`;
}
