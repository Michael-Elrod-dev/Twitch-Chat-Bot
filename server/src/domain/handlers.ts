import type { UserLevel } from './permissions.js';

/**
 * Handler-backed commands declare the level they require. The declaration is the
 * single source of truth, and a database row that disagrees is corrected at
 * load, so the table stops lying.
 *
 * Handlers themselves live with their domains. This is the registry shape they
 * slot into.
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
     * column, because a handler-backed row has no `responseText` to show there.
     *
     * Required, so behavior and the sentence describing it cannot be edited
     * apart. Holding the same map on the client instead means a built-in added
     * here renders a generic placeholder until somebody remembers to edit a
     * file in another workspace.
     *
     * One short phrase, no trailing full stop, present tense. It sits in a
     * table cell beside a command name, not in a paragraph.
     */
    description: string;
}

export type HandlerRegistry = Readonly<Record<string, HandlerRegistration>>;

/*
 * There is deliberately no `declaredLevels` or `declaredDescriptions` helper
 * here.
 *
 * `CommandManager.load` reconciles the database against the registry by reading
 * `registration.level` and `registration.description` directly off each entry.
 * A module-level projection of the same two fields would exist only to be
 * exported, and an exported helper with a test and no caller is dead code
 * wearing a green tick. The test passes, the coverage counts, and nothing it
 * covers runs.
 *
 * A second reconciliation path nobody calls is also precisely where the registry
 * and the rows would be free to drift, because no failing test would ever say
 * so.
 */
