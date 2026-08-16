/**
 * The realtime contract.
 *
 * Deliberately a small, closed set. Every event here is one the desktop app has
 * a reason to render; a firehose of everything the pipeline does would be a
 * bigger surface to keep compatible for no benefit, and the REST API already
 * answers "what is the current state".
 *
 * Every event carries `channelId` even though a socket only ever receives its
 * own channel's events. That redundancy is deliberate: it makes a fan-out bug
 * assertable from the client side rather than invisible.
 */

export interface LiveChatMessage {
    type: 'chat.message';
    channelId: string;
    at: string;
    chatter: { login: string; displayName: string };
    text: string;
    /**
     * What the pipeline decided, so the UI can show why the bot did or did not
     * answer. Drives the outcome chip: `command` → CMD, `emote` → EMOTE,
     * `ai` → AI; `none` and `skipped` render no chip at all.
     *
     * `skipped` is retained rather than folded into `none` because they are
     * different facts — `none` means nothing matched, `skipped` means the
     * pipeline deliberately declined (the bot's own message, or one already
     * arriving as a redemption). The UI treats them the same today; the log
     * and any future debugging surface should not have to guess.
     */
    outcome: 'command' | 'emote' | 'ai' | 'none' | 'skipped';
    /**
     * True when this line is the bot's own message coming back to us.
     *
     * The bot's replies arrive as ordinary `channel.chat.message` deliveries,
     * so the feed sees them like any other line. The design gives those rows a
     * background wash, which needs a marker `outcome` cannot supply: `skipped`
     * also covers reward-attached viewer messages, and washing one of those
     * would tell the broadcaster their viewer was the bot.
     */
    fromBot: boolean;
}

export interface LiveSongQueueUpdated {
    type: 'song_queue.updated';
    channelId: string;
    at: string;
    queueLength: number;
}

export interface LiveChannelStatus {
    type: 'channel.status';
    channelId: string;
    at: string;
    live: boolean;
    sessionState: 'stopped' | 'starting' | 'running' | 'stopping';
}

/** Sent once on connect so a client can render immediately rather than waiting. */
export interface LiveHello {
    type: 'hello';
    channelId: string;
    at: string;
    login: string;
}

export type LiveEvent = LiveHello | LiveChatMessage | LiveSongQueueUpdated | LiveChannelStatus;

export const LIVE_EVENT_TYPES = [
    'hello',
    'chat.message',
    'song_queue.updated',
    'channel.status'
] as const;

/** WebSocket path. Exported so the client cannot drift from the server. */
export const LIVE_PATH = '/api/v1/live';

/**
 * Heartbeat interval. The server pings on this cadence and reaps a socket that
 * has not ponged by the next one — a TCP connection to a laptop that closed its
 * lid stays "open" indefinitely otherwise, and every dead socket is a channel's
 * worth of events being written to nowhere.
 */
export const LIVE_HEARTBEAT_MS = 30_000;
