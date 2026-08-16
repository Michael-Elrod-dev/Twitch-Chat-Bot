import type { UserLevel } from './permissions.js';

/**
 * Handler-backed commands declare the level they require. The declaration is the
 * single source of truth; a database row that disagrees is corrected at load
 * (Phase 0 WP-6 task 9 — the DB stops lying).
 *
 * Handlers themselves arrive with their domains in P1-WP4.1/4.2/4.3; this is the
 * registry shape they slot into.
 */
export interface HandlerContext {
    channelId: string;
    args: string[];
    chatter: {
        twitchUserId: string;
        login: string;
        displayName: string;
        /*
         * The chatter's roles in THIS channel. The pipeline has always passed
         * them (it forwards the whole chat event chatter); the type simply did
         * not say so, which left handlers unable to reach what was already
         * there.
         */
        isModerator: boolean;
        isVip: boolean;
        isSubscriber: boolean;
        isBroadcaster: boolean;
    };
    reply: (message: string) => Promise<void>;
}

export type CommandHandler = (context: HandlerContext) => Promise<void>;

export interface HandlerRegistration {
    handler: CommandHandler;
    level: UserLevel;
}

export type HandlerRegistry = Readonly<Record<string, HandlerRegistration>>;

/** Levels only, for callers that reconcile the database against declarations. */
export function declaredLevels(registry: HandlerRegistry): Record<string, UserLevel> {
    return Object.fromEntries(Object.entries(registry).map(([name, reg]) => [name, reg.level]));
}
