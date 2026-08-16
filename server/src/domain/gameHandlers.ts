import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { AiService, GamePromptType } from '../services/aiService.js';
import type { Logger } from '../logger.js';

/**
 * `!advice` and `!roast` — the AI game commands.
 *
 * ## Where the profile comes from: nowhere, and that is the correct answer
 *
 * Phase 0's prompts accept a "profile context" for the target, read from
 * `viewers.context`. Resolving that column for P1-WP4.3 turned up three facts:
 *
 *  1. **Nothing in the Phase-0 codebase ever wrote it.** The column appears in
 *     `contextBuilder.getUserProfile`'s SELECT and in `promptBuilder`, and in no
 *     INSERT or UPDATE anywhere.
 *  2. **The recovered dump carries zero values.** All 1509 viewer rows — the
 *     owner's real data, matching the verified import count — have it NULL.
 *  3. So the feature was vestigial: every `!advice` and `!roast` Phase 0 ever
 *     answered took the prompts' own "if no profile context exists" branch.
 *
 * These therefore port profile-less, which is not a regression but an accurate
 * description of what the commands always did. Nothing is lost, and no dead
 * column is carried into v2 to look like data that does not exist. A curated
 * profile is a real feature the app can add later — with a writer.
 */

export interface GameHandlerDeps {
    ai: AiService;
    roles: ChannelRoleRepository;
    logger: Logger;
}

function createGameHandler(type: GamePromptType, deps: GameHandlerDeps): HandlerRegistry[string] {
    return {
        level: 'everyone',
        handler: async (context: HandlerContext): Promise<void> => {
            // `!roast @name`, or the caller when no target is given.
            const requested = (context.args[0] ?? '').replace('@', '').trim();
            const self = requested === '' || requested.toLowerCase() === context.chatter.login.toLowerCase();

            const target = self
                ? { twitchUserId: context.chatter.twitchUserId, login: context.chatter.login }
                : await deps.roles.findByLogin(requested);

            if (!target) {
                await context.reply(`@${context.chatter.displayName} I have not seen ${requested} in this chat.`);
                return;
            }

            const result = await deps.ai.handleGameRequest(
                type,
                { twitchUserId: target.twitchUserId, displayName: target.login },
                // The requester pays. See GameRequestRequester for why.
                { twitchUserId: context.chatter.twitchUserId, roles: context.chatter }
            );

            await context.reply(
                result.ok
                    ? `@${target.login} ${result.response}`
                    : `@${context.chatter.displayName} ${result.message}`
            );
        }
    };
}

export function createGameHandlers(deps: GameHandlerDeps): HandlerRegistry {
    return {
        /* Handler names match the rows already in the owner's database. */
        advice: createGameHandler('advice', deps),
        roast: createGameHandler('roast', deps)
    };
}
