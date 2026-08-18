import {
    chatTextSchema,
    commandNameSchema,
    emoteTriggerSchema,
    createQuoteSchema,
    aiLimitsSchema,
    createApiKeySchema,
    updateSettingsSchema
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
 * The alternative, a regex here that looks like the regex there, is a familiar
 * failure. Two things agree with each
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
    /** The normalized value, lowercased and trimmed, when `ok`. */
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
        // The schema's first message. These are written for humans already, so
        // "must start with ! and contain no spaces" needs no translation.
        message: issues?.[0]?.message ?? 'That is not valid'
    };
}

/** Leading `!`, no spaces, 2 to 64, lowercased. All of it the schema's opinion. */
export function validateCommandName(raw: string): ValidationResult {
    return check(commandNameSchema, raw);
}

/** 1 to 500 after trimming. Twitch truncates beyond 500, so the server refuses. */
export function validateReply(raw: string): ValidationResult {
    return check(chatTextSchema, raw);
}

/** Exact-match triggers get the same normalization as command names. */
export function validateEmoteTrigger(raw: string): ValidationResult {
    return check(emoteTriggerSchema, raw);
}

export function validateQuoteText(raw: string): ValidationResult {
    return check(createQuoteSchema.shape.quoteText, raw);
}

/**
 * The playlist the streamer names on `5a`.
 *
 * `.nullable().optional()` on the contract's field means `undefined` is a valid
 * value, meaning "not mentioned in this PATCH". A form must not treat that as a pass,
 * because an empty box is a name the streamer has not given, so the raw string
 * goes in and the schema's `min(1)` refuses it.
 */
export function validatePlaylistName(raw: string): ValidationResult {
    return check(updateSettingsSchema.shape.requestsPlaylistName, raw);
}

/** The Discord webhook on `5b`. The URL rule is the contract's, not a regex here. */
export function validateWebhookUrl(raw: string): ValidationResult {
    return check(updateSettingsSchema.shape.discordWebhookUrl, raw);
}

/** The name on a Stream Deck key. */
export function validateApiKeyName(raw: string): ValidationResult {
    return check(createApiKeySchema.shape.name, raw);
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

/**
 * The stepper's ends, from the schema that decides whether a save is accepted.
 *
 * Zero is a real setting, the AI off for that tier and on for the ones above it,
 * so the floor is `min` and not one. The ceiling is a fat-finger guard rather than
 * a policy, which is exactly why it must not be re-typed at the control: a
 * stepper that stopped at a number the server no longer enforces would be
 * inventing a rule.
 */
export const AI_LIMIT_MIN: number = aiLimitsSchema.shape.everyone.minValue ?? 0;
export const AI_LIMIT_MAX: number = aiLimitsSchema.shape.everyone.maxValue ?? 10_000;
