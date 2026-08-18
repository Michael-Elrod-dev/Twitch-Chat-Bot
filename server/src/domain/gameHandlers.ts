import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { AiService, GamePromptType } from '../services/aiService.js';
import type { Logger } from '../logger.js';

/**
 * `!advice` and `!roast`, the AI game commands.
 *
 * Neither passes a profile for the target, and there is no profile to pass. The
 * prompts have a "profile context" slot, but nothing has ever written a viewer
 * profile and the recovered dump carries none, so every answer takes the
 * prompts' own "if no profile context exists" branch.
 *
 * Running profile-less is therefore an accurate description of the commands
 * rather than a reduction of them, and no dead column is carried forward to look
 * like data that does not exist. A curated profile is a real feature the app can
 * add later, together with something that writes one.
 */

export interface GameHandlerDeps {
    ai: AiService;
    roles: ChannelRoleRepository;
    logger: Logger;
}

/** One phrase per game type, kept beside the handler they describe. */
const GAME_DESCRIPTIONS: Readonly<Record<GamePromptType, string>> = {
    advice: 'Asks the AI for advice',
    roast: 'Asks the AI to roast someone'
};

function createGameHandler(type: GamePromptType, deps: GameHandlerDeps): HandlerRegistry[string] {
    return {
        level: 'everyone',
        description: GAME_DESCRIPTIONS[type],
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
