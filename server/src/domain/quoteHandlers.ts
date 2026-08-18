import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { QuoteManager } from './quoteManager.js';
import type { CommandManager } from './commandManager.js';
import type { Logger } from '../logger.js';

/**
 * `!quote` and `!command` — the two handlers P1-WP4.3's gate audit missed.
 *
 * Both have `handler_name` rows in the owner's production `commands` table and
 * neither had an implementation in Phase 1, so both answered nothing. They were
 * not in the "last five" because my WP4.3 comparison enumerated only inline
 * handler literals and never checked these two.
 *
 * `modCommands` is the odder of the pair: it has **no implementation in Phase 0
 * either**. Legacy intercepted `!command` inside `CommandManager.handleCommand`
 * before the handler registry was consulted, so the row's `handler_name` was
 * decorative — it named a handler that never existed. Phase 1 has no such
 * interception (dispatch is uniform), so the behavior has to live where the
 * row already says it does.
 */

export interface QuoteHandlerDeps {
    quotes: QuoteManager;
    /**
     * Resolved lazily: `!command` edits the very registry it is registered in,
     * so the CommandManager does not exist yet when these handlers are built.
     * The thunk is only ever called from inside a handler, long after.
     */
    commands: () => CommandManager;
    logger: Logger;
}

const USAGE = 'Usage: !command <add/edit/delete> !commandname [message]';

export function createQuoteHandlers(deps: QuoteHandlerDeps): HandlerRegistry {
    return {
        quoteHandler: {
            level: 'everyone',
            description: 'Returns a saved quote',
            handler: async (context: HandlerContext): Promise<void> => {
                const total = await deps.quotes.count();
                if (total === 0) {
                    await context.reply('No quotes saved yet!');
                    return;
                }

                // `!quote 7` for a specific one, `!quote` for a random one.
                const requested = context.args[0];
                const asNumber = requested === undefined ? undefined : Number(requested);

                if (asNumber !== undefined && !Number.isInteger(asNumber)) {
                    await context.reply(USAGE_QUOTE);
                    return;
                }

                const quote = await deps.quotes.get(asNumber);
                if (!quote) {
                    await context.reply(`Quote #${requested} not found!`);
                    return;
                }

                await context.reply(
                    `Quote #${quote.quoteNumber}/${total} - '${quote.quoteText}' - `
                    + `${quote.author ?? 'unknown'}, ${quote.savedAt.getFullYear()}`
                );
            }
        },

        /**
         * `!command add|edit|delete !name [message]`.
         *
         * Declares `mod` here rather than trusting the row, which is the WP-6
         * lesson: a handler enforcing a permission the table disagrees with
         * means the table is lying to whoever reads it.
         */
        modCommands: {
            level: 'mod',
            description: 'Adds, edits and removes commands from chat',
            handler: async (context: HandlerContext): Promise<void> => {
                const [action, rawName, ...rest] = context.args;

                if (!action || !rawName) {
                    await context.reply(USAGE);
                    return;
                }

                if (!rawName.startsWith('!')) {
                    await context.reply('Command must start with !');
                    return;
                }

                const name = rawName.toLowerCase();
                const message = rest.join(' ').trim();

                switch (action.toLowerCase()) {
                case 'add': {
                    if (message === '') {
                        await context.reply('Usage: !command add !commandname <message>');
                        return;
                    }
                    if (await deps.commands().get(name)) {
                        await context.reply(`${name} already exists. Use !command edit to change it.`);
                        return;
                    }

                    await deps.commands().create({
                        // A command written from chat is static: its reply is
                        // its own description.
                        name, responseText: message, handlerName: null,
                        description: null, userLevel: 'everyone'
                    });
                    await context.reply(`Added ${name}`);
                    return;
                }

                case 'edit': {
                    if (message === '') {
                        await context.reply('Usage: !command edit !commandname <message>');
                        return;
                    }

                    await context.reply(
                        await deps.commands().updateResponse(name, message)
                            ? `Updated ${name}`
                            : `${name} not found`
                    );
                    return;
                }

                case 'delete':
                    await context.reply(
                        await deps.commands().delete(name) ? `Deleted ${name}` : `${name} not found`
                    );
                    return;

                default:
                    await context.reply(USAGE);
                }
            }
        }
    };
}

const USAGE_QUOTE = 'Usage: !quote [number]';
