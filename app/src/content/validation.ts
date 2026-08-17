import {
    chatTextSchema,
    commandNameSchema,
    emoteTriggerSchema,
    createQuoteSchema
} from '@almosthadai/shared';

/**
 * Client-side validation, by asking the server's own schemas.
 *
 * **Nothing here restates a rule.** The handoff says command validation
 * "mirrors `commandNameSchema`", and the only mirror that cannot crack is the
 * one that holds no glass of its own: these functions run the very schema the
 * route validates with, so a rule can be changed in `shared/` and the form
 * follows without anyone remembering it exists.
 *
 * The alternative — a regex here that looks like the regex there — is the
 * failure this codebase has already met twice: two things that agree with each
 * other and not with reality (the reconciler's fixture) or with each other and
 * not with the wire (the redemption condition). A form that accepts what the
 * server rejects wastes a round trip; a form that rejects what the server
 * accepts is worse, because nothing on screen can explain it.
 *
 * Lowercasing comes free: both schemas carry a `.transform`, so `parse` returns
 * the value the server would have stored, and the caller submits that.
 */

export interface ValidationResult {
    ok: boolean;
    /** The normalised value — lowercased and trimmed — when `ok`. */
    value: string;
    /** The schema's own message when not. */
    message: string;
}

function check(schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }, raw: string): ValidationResult {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, value: String(result.data), message: '' };

    const issues = (result.error as { issues?: { message: string }[] } | undefined)?.issues;
    return {
        ok: false,
        value: raw,
        // The schema's first message. These are written for humans already —
        // "must start with ! and contain no spaces" needs no translation.
        message: issues?.[0]?.message ?? 'That is not valid'
    };
}

/** Leading `!`, no spaces, 2–64, lowercased — all of it the schema's opinion. */
export function validateCommandName(raw: string): ValidationResult {
    return check(commandNameSchema, raw);
}

/** 1–500 after trimming. Twitch truncates beyond 500, so the server refuses. */
export function validateReply(raw: string): ValidationResult {
    return check(chatTextSchema, raw);
}

/** Exact-match triggers get the same normalisation as command names. */
export function validateEmoteTrigger(raw: string): ValidationResult {
    return check(emoteTriggerSchema, raw);
}

export function validateQuoteText(raw: string): ValidationResult {
    return check(createQuoteSchema.shape.quoteText, raw);
}

/**
 * The reply counter's denominator, read off the schema rather than typed here.
 *
 * The handoff draws `62 / 500`. Writing `500` in a component would be a second
 * copy of a limit that already exists, and the kind that stays at 500 after the
 * schema moves.
 */
export const REPLY_MAX_LENGTH: number = chatTextSchema.maxLength ?? 500;

/** Same reasoning, for the quote form. */
export const QUOTE_MAX_LENGTH: number = createQuoteSchema.shape.quoteText.maxLength ?? 1000;
