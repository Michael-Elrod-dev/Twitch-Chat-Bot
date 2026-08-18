import { z } from 'zod';

/**
 * The typed API contract.
 *
 * This package is what the desktop app builds against: request schemas the
 * server validates with and response types the client consumes, from one
 * definition. A drift between what the server accepts and what the client sends
 * becomes a compile error rather than a runtime 400.
 *
 * Note what is deliberately absent: **there is no channel id anywhere in this
 * contract.** The caller's token identifies the tenant, so a request cannot
 * name a channel and therefore cannot name the wrong one.
 */

/** Permission tiers, ordered. Mirrors the server's domain model. */
export const USER_LEVELS = ['everyone', 'vip', 'mod', 'broadcaster'] as const;
export const userLevelSchema = z.enum(USER_LEVELS);
export type UserLevel = z.infer<typeof userLevelSchema>;

/**
 * Command names.
 *
 * Leading `!` required and normalized to lowercase, because the chat pipeline
 * looks them up lowercased. Accepting `!Foo` here and never matching it in
 * chat would be a silent failure the user cannot diagnose.
 */
export const commandNameSchema = z
    .string()
    .trim()
    .min(2, 'a command needs a name after the !')
    .max(64)
    .regex(/^![^\s]+$/, 'must start with ! and contain no spaces')
    .transform((value) => value.toLowerCase());

/** Chat-visible text. Twitch truncates beyond 500, so refuse rather than surprise. */
export const chatTextSchema = z.string().trim().min(1).max(500);

/** Emote triggers match on exact text, so the same normalization applies. */
export const emoteTriggerSchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((value) => value.toLowerCase());

export const paginationSchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0)
});
export type Pagination = z.infer<typeof paginationSchema>;

/** Envelope for a listing, so clients can page without guessing. */
export interface Page<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}
