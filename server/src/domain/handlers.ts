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
    /**
     * What this command does, in the streamer's words, for the app's reply
     * column — a handler-backed row has no `responseText` to show there.
     *
     * **Required, so behaviour and the sentence describing it cannot be edited
     * apart.** The content screens shipped this map on the client instead, and
     * the cost was exactly what a required field prevents: a built-in added
     * here rendered "A built-in behaviour" until somebody remembered a file in
     * another workspace. Optional would have re-offered that.
     *
     * One short phrase, no trailing full stop, present tense — it sits in a
     * table cell beside a command name, not in a paragraph.
     */
    description: string;
}

export type HandlerRegistry = Readonly<Record<string, HandlerRegistration>>;

/*
 * There is deliberately no `declaredLevels` or `declaredDescriptions` helper
 * here.
 *
 * Both were written; neither had a production caller. `CommandManager.load`
 * reconciles the database against the registry by reading `registration.level`
 * and `registration.description` directly off each entry, so a module-level
 * projection of the same two fields exists only to be exported — and an exported
 * helper with a test and no caller is dead code wearing a green tick. The test
 * passes, the coverage counts, and nothing it covers runs.
 *
 * `declaredLevels` outlived its companion by one package, on the reasoning that
 * deleting it was not that change's business. It is this one's: a second
 * reconciliation path nobody calls is precisely where the registry and the rows
 * would be free to drift, because no failing test would ever say so.
 */
