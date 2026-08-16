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
    /** What the pipeline decided, so the UI can show why the bot did or did not answer. */
    outcome: 'command' | 'emote' | 'ai' | 'none' | 'skipped';
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
