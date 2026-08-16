import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { SettingsService } from './settings.js';
import type { Logger } from '../logger.js';

/**
 * The AI command handlers.
 *
 * `!ai on|off` declares `mod` here rather than trusting whatever the database
 * row says. That declaration is authoritative — `CommandManager` corrects a
 * disagreeing row at load — which is the Phase-0 WP-6 lesson: a handler that
 * enforced its own permission while the table claimed `everyone` meant the
 * table was lying to anyone reading it.
 */

export interface AiHandlerDeps {
    settings: SettingsService;
    logger: Logger;
}

export function createAiHandlers(deps: AiHandlerDeps): HandlerRegistry {
    return {
        /*
         * Named to match the handler_name the Phase-0 data already carries
         * ('toggleAI', mod-level). The imported row is the owner's; the handler
         * name is ours to choose, so it bends.
         */
        toggleAI: {
            level: 'mod',
            handler: async (context: HandlerContext): Promise<void> => {
                const arg = (context.args[0] ?? '').toLowerCase();

                if (arg !== 'on' && arg !== 'off') {
                    // Reports the current state rather than erroring: someone
                    // typing `!ai` alone almost always wants to know.
                    const enabled = await deps.settings.isAiEnabled();
                    await context.reply(`AI is currently ${enabled ? 'on' : 'off'}. Use !ai on or !ai off.`);
                    return;
                }

                const enable = arg === 'on';
                await deps.settings.setAiEnabled(enable);

                deps.logger.info(
                    { channelId: context.channelId, enabled: enable, by: context.chatter.login },
                    'AI toggled'
                );

                await context.reply(`AI is now ${enable ? 'on' : 'off'}.`);
            }
        }
    };
}
