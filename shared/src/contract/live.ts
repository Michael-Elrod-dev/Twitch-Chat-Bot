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

/**
 * What a chatter *is* in this channel, for the feed's name coloring.
 *
 * Deliberately NOT `UserLevel`. That type answers "who is allowed to run this
 * command" and includes `everyone`, which is a threshold rather than anything a
 * person holds; this answers "what is this person", where the bottom of the
 * scale is an ordinary viewer. They order the same way and mean different
 * things, so they are kept apart rather than unified into a type that would be
 * wrong half the time it was read.
 */
export type ChatRole = 'broadcaster' | 'moderator' | 'vip' | 'viewer';

export interface LiveChatMessage {
    type: 'chat.message';
    channelId: string;
    at: string;
    /**
     * `role` is the highest tier this chatter holds, so the feed can color the
     * broadcaster clay and moderators sage. It is exposure of a decision the
     * pipeline already makes per message, not a second derivation — the
     * permission check and this read the same role flags off the same event.
     */
    chatter: { login: string; displayName: string; role: ChatRole };
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
    /**
     * How many songs are waiting after this change.
     *
     * **Wired, not dropped** — the flag carried since the dashboard package,
     * resolved here with its reasoning. The field was declared and never put on
     * the wire: the one publisher sent a bare `{ type }`, so every client read
     * `undefined` and the type said otherwise.
     *
     * Wiring it rather than amending the contract, because the number is what
     * two headers actually render (`6 waiting` on the songs screen, the queue
     * card's meta on the dashboard) and the server already holds it at the
     * moment it publishes. Dropping the field would have made every queue
     * change cost a refetch to learn a count the emitter knew.
     *
     * The same pass fixed the larger half of the gap: the event only ever fired
     * on skip, so a viewer redeeming a song left the queue card stale until
     * something else happened to it. It now fires wherever the queue changes.
     */
    queueLength: number;
}

export interface LiveChannelStatus {
    type: 'channel.status';
    channelId: string;
    at: string;
    live: boolean;
    sessionState: 'stopped' | 'starting' | 'running' | 'stopping';
    /**
     * When the current stream began, or null when the channel is not live.
     *
     * The uptime clock's source of truth. It is deliberately the stream's own
     * start time and NOT `at`: `at` is when this event was emitted, so a client
     * that seeded its clock from it would restart the count at every status
     * change and read `0:00:03` an hour into a stream. The client ticks locally
     * once a second from this value and re-syncs whenever a new status arrives,
     * which is what keeps a machine with a drifting clock — or one that just
     * woke from sleep — honest.
     */
    startedAt: string | null;
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
