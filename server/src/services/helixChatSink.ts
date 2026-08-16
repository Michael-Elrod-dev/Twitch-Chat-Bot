import type { Logger } from '../logger.js';
import type { ChatSink, OutboundMessage } from './chatSink.js';
import type { HelixApi } from '../twitch/helixApi.js';
import { RateLimitedError, HelixError } from '../twitch/errors.js';

/**
 * The bot actually speaking.
 *
 * Sends run on the **app** access token, which is what makes one shared bot
 * account work across N channels without a per-channel bot token. The
 * authorization requirement mirrors the read path exactly: `user:write:chat` +
 * `user:bot` from the bot, and `channel:bot` from the broadcaster
 * (docs/PHASE1_EVENTSUB_FACTS.md §4).
 */

/** Twitch truncates beyond this; truncating here keeps the ellipsis meaningful. */
const MAX_MESSAGE_LENGTH = 500;

export interface HelixChatSinkOptions {
    helix: HelixApi;
    /**
     * The shared bot's Twitch user id — the `sender_id` on every send.
     *
     * Accepts a getter so a re-granted consent takes effect immediately. Holding
     * the value would mean the bot kept speaking as the previous account until
     * someone restarted the process.
     */
    botUserId: string | (() => string);
    logger: Logger;
}

export class HelixChatSink implements ChatSink {
    private readonly options: HelixChatSinkOptions;

    constructor(options: HelixChatSinkOptions) {
        this.options = options;
    }

    async send({ channelId, broadcasterTwitchId, text }: OutboundMessage): Promise<void> {
        const { helix, logger } = this.options;
        const botUserId = typeof this.options.botUserId === 'function'
            ? this.options.botUserId()
            : this.options.botUserId;

        if (botUserId === '') {
            logger.error({ channelId }, 'Cannot send chat: no bot identity is configured');
            return;
        }

        const message = text.length > MAX_MESSAGE_LENGTH
            ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
            : text;

        try {
            const result = await helix.sendChatMessage(broadcasterTwitchId, botUserId, message);

            if (!result.sent) {
                // Accepted by the API but not delivered - AutoMod, or a channel
                // setting. A silent drop here would look exactly like a bug in
                // the command that produced it.
                logger.warn(
                    { channelId, broadcasterTwitchId, dropReason: result.dropReason },
                    'Chat message accepted but not delivered'
                );
                return;
            }

            logger.debug({ channelId, broadcasterTwitchId }, 'Chat message sent');
        } catch (err) {
            // A failed send must never propagate into the pipeline: one channel
            // being unable to speak is not a reason to stop processing its
            // messages, let alone anyone else's.
            if (err instanceof RateLimitedError) {
                logger.warn(
                    { channelId, retryAfterMs: err.retryAfterMs },
                    'Chat send rate limited - message dropped rather than queued'
                );
                return;
            }

            if (err instanceof HelixError && err.status === 401) {
                logger.error(
                    { channelId, twitchMessage: err.twitchMessage },
                    'Chat send rejected as unauthorized - check the bot account scopes and the broadcaster channel:bot grant'
                );
                return;
            }

            logger.error({ channelId, err: (err as Error).message }, 'Chat send failed');
        }
    }
}
