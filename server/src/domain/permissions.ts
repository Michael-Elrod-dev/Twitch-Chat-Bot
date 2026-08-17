import type { ChatRole } from '@almosthadai/shared';
import type { ChannelRoleRecord } from '../db/repositories/channelRoleRepository.js';

export const USER_LEVELS = ['everyone', 'vip', 'mod', 'broadcaster'] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

/**
 * Ordered ranks: a command at a given level runs for that level and everything
 * above it. Ported verbatim from Phase 0 WP-7.1, including the reasoning behind
 * the fail-open default below.
 */
const RANK: Record<UserLevel, number> = {
    everyone: 0,
    vip: 1,
    mod: 2,
    broadcaster: 3
};

/** What a chatter is, in one channel. Roles are channel-relative, never global. */
export interface ChatterRoles {
    isModerator: boolean;
    isVip: boolean;
    isSubscriber: boolean;
    isBroadcaster: boolean;
}

export const NO_ROLES: ChatterRoles = {
    isModerator: false,
    isVip: false,
    isSubscriber: false,
    isBroadcaster: false
};

export function rolesFromRecord(record: ChannelRoleRecord | null): ChatterRoles {
    return record ?? NO_ROLES;
}

/** The highest tier this chatter holds in this channel. */
export function rankOf(roles: ChatterRoles): number {
    if (roles.isBroadcaster) return RANK.broadcaster;
    if (roles.isModerator) return RANK.mod;
    if (roles.isVip) return RANK.vip;
    return RANK.everyone;
}

/**
 * The same precedence as `rankOf`, named for the realtime feed.
 *
 * Directly beneath `rankOf` on purpose: these two must agree about who outranks
 * whom, and the cheapest way to keep them agreeing is for a reader changing one
 * to have the other on screen. A viewer the pipeline treats as a moderator must
 * never render as an ordinary viewer, and vice versa.
 *
 * `viewer` rather than `everyone`: this says what someone IS, where `UserLevel`
 * says what a command REQUIRES, and `everyone` is not a thing anybody is.
 */
export function chatRoleOf(roles: ChatterRoles): ChatRole {
    if (roles.isBroadcaster) return 'broadcaster';
    if (roles.isModerator) return 'moderator';
    if (roles.isVip) return 'vip';
    return 'viewer';
}

export function isUserLevel(value: string): value is UserLevel {
    return (USER_LEVELS as readonly string[]).includes(value);
}

/**
 * The single place permission is decided.
 *
 * An unrecognised level resolves to `everyone` — deliberately fail-OPEN. The
 * database CHECK constraint added in P1-WP3 is what keeps bad values out of the
 * data path; failing closed here would instead disable a command on a code typo,
 * which is the worse outcome. (Phase 0 WP-7.1, decision recorded by the lead.)
 */
export function hasPermission(requiredLevel: string, roles: ChatterRoles): boolean {
    const required = isUserLevel(requiredLevel) ? RANK[requiredLevel] : RANK.everyone;
    return rankOf(roles) >= required;
}
