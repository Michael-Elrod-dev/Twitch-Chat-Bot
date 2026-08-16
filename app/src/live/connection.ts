import { LIVE_PATH, type LiveEvent } from '@almosthadai/shared';
import { API_BASE_URL } from '../api/config.js';

/**
 * The realtime connection, as a state machine.
 *
 * ## Why this is separate from channel status
 *
 * `connecting / open / reconnecting / down` describes **our link to the
 * server**. It says nothing about whether the broadcaster is live, whether the
 * bot is running, or whether Twitch is happy. The handoff is explicit (`4b`):
 * when the server is unreachable every status tile reads `?` / "Unknown" —
 * never zero, which would be a lie about a bot that is very likely still
 * running perfectly well without us watching.
 *
 * So this module deliberately exposes no notion of channel state. A consumer
 * that wants to conflate the two has to do it on purpose.
 *
 * ## Reconnection
 *
 * Exponential backoff with full jitter, capped. The cap matters because a
 * desktop app left open overnight through a router reboot should still come
 * back promptly; the jitter matters because every client of a server that just
 * restarted would otherwise return in lockstep.
 */

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'down';

export interface ConnectionOptions {
    accessToken: string;
    onEvent: (event: LiveEvent) => void;
    onStateChange: (state: ConnectionState) => void;
    /** Injected in tests. */
    socketFactory?: (url: string) => WebSocketLike;
    setTimeoutImpl?: (fn: () => void, ms: number) => number;
    clearTimeoutImpl?: (handle: number) => void;
    randomImpl?: () => number;
}

/** The slice of WebSocket this module uses, so a fake needs nothing more. */
export interface WebSocketLike {
    close: () => void;
    onopen: ((this: unknown, ev: unknown) => unknown) | null;
    onclose: ((this: unknown, ev: unknown) => unknown) | null;
    onerror: ((this: unknown, ev: unknown) => unknown) | null;
    onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/**
 * After this many consecutive failures the connection reports `down` rather
 * than `reconnecting`, and keeps trying.
 *
 * The distinction is what the UI shows: `reconnecting` is a quiet inline note
 * because a blip should not throw a banner over a working bot, while `down` is
 * the `4b` banner. Three attempts is roughly a few seconds of trying — long
 * enough that the user is not being told about a hiccup they never noticed.
 */
const ATTEMPTS_BEFORE_DOWN = 3;

export class LiveConnection {
    private readonly options: ConnectionOptions;
    private readonly newSocket: (url: string) => WebSocketLike;
    private readonly schedule: (fn: () => void, ms: number) => number;
    private readonly unschedule: (handle: number) => void;
    private readonly random: () => number;

    private socket: WebSocketLike | null = null;
    private state: ConnectionState = 'down';
    private attempts = 0;
    private retryHandle: number | null = null;
    private stopped = false;

    constructor(options: ConnectionOptions) {
        this.options = options;
        this.newSocket = options.socketFactory
            ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
        this.schedule = options.setTimeoutImpl
            ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
        this.unschedule = options.clearTimeoutImpl ?? ((handle) => { clearTimeout(handle); });
        this.random = options.randomImpl ?? Math.random;
    }

    get currentState(): ConnectionState {
        return this.state;
    }

    /** Attempt number of the connection in flight. Exposed for tests. */
    get attemptCount(): number {
        return this.attempts;
    }

    start(): void {
        this.stopped = false;
        this.open('connecting');
    }

    /** Closes for good. Safe to call more than once. */
    stop(): void {
        this.stopped = true;
        if (this.retryHandle !== null) {
            this.unschedule(this.retryHandle);
            this.retryHandle = null;
        }
        this.detach();
        this.socket?.close();
        this.socket = null;
        this.setState('down');
    }

    private open(as: ConnectionState): void {
        this.setState(as);

        /*
         * The token rides in the query string because a browser WebSocket
         * cannot set an Authorization header. That is a known wart of the
         * protocol; the server is what decides whether to accept it, and the
         * app has no other option available to it.
         */
        const base = API_BASE_URL.replace(/^http/, 'ws');
        const socket = this.newSocket(
            `${base}${LIVE_PATH}?access_token=${encodeURIComponent(this.options.accessToken)}`
        );
        this.socket = socket;

        socket.onopen = () => {
            this.attempts = 0;
            this.setState('open');
        };

        socket.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            let parsed: LiveEvent;
            try {
                parsed = JSON.parse(event.data) as LiveEvent;
            } catch {
                // A frame we cannot read is dropped rather than taking the
                // connection down with it — the feed is ambient, not a log.
                return;
            }
            this.options.onEvent(parsed);
        };

        socket.onerror = () => {
            // `onclose` always follows, and doing the work in one place keeps
            // a single error+close pair from counting as two failures.
        };

        socket.onclose = () => { this.handleDrop(); };
    }

    private handleDrop(): void {
        if (this.stopped) return;

        this.detach();
        this.socket = null;
        this.attempts += 1;

        // A blip stays quiet; a real outage gets the banner. Both keep trying.
        this.setState(this.attempts >= ATTEMPTS_BEFORE_DOWN ? 'down' : 'reconnecting');

        this.retryHandle = this.schedule(() => {
            this.retryHandle = null;
            if (this.stopped) return;
            this.open(this.state === 'down' ? 'down' : 'reconnecting');
        }, this.backoffMs());
    }

    /** Exponential with full jitter, capped. */
    private backoffMs(): number {
        const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this.attempts - 1));
        return Math.round(this.random() * ceiling);
    }

    private detach(): void {
        if (!this.socket) return;
        this.socket.onopen = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.onmessage = null;
    }

    private setState(next: ConnectionState): void {
        if (this.state === next) return;
        this.state = next;
        this.options.onStateChange(next);
    }
}
