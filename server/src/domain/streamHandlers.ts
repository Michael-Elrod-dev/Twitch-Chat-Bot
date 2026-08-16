import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { StreamService } from './streamService.js';

/**
 * Stream-context commands.
 *
 * `!uptime` is the one Phase-0 command that could never be ported before now,
 * because it needs a stream to ask about. It answers from the recorded stream's
 * real start time rather than from process uptime — a mid-stream deploy must
 * not reset it.
 */

export interface StreamHandlerDeps {
    streams: StreamService;
    broadcasterLogin: string;
}

export function createStreamHandlers(deps: StreamHandlerDeps): HandlerRegistry {
    return {
        /* Matches the handler_name already in the owner's imported rows. */
        uptime: {
            level: 'everyone',
            handler: async (context: HandlerContext): Promise<void> => {
                const elapsed = deps.streams.uptime();

                await context.reply(
                    elapsed
                        ? `${deps.broadcasterLogin} has been live for ${elapsed}.`
                        : `${deps.broadcasterLogin} is not live right now.`
                );
            }
        }
    };
}
