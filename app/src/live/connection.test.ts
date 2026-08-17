import { describe, it, expect } from 'vitest';
import type { LiveEvent } from '@almosthadai/shared';
import { LiveConnection, type ConnectionState, type WebSocketLike } from './connection.js';

/**
 * The reconnect state machine.
 *
 * Driven through a fake socket and a fake clock so the whole sequence —
 * connecting, dropping, backing off, coming back — runs without a real server
 * or a real second passing.
 */

class FakeSocket implements WebSocketLike {
    onopen: WebSocketLike['onopen'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    closed = false;

    constructor(readonly url: string) {}

    close(): void { this.closed = true; }

    open(): void { this.onopen?.call(this, {}); }
    drop(): void { this.onclose?.call(this, {}); }
    send(data: unknown): void { this.onmessage?.call(this, { data }); }
}

interface Harness {
    connection: LiveConnection;
    sockets: FakeSocket[];
    states: ConnectionState[];
    events: LiveEvent[];
    /**
     * Runs the single pending timer, then settles the token promise the retry
     * awaits before it can build a socket.
     */
    tick: () => Promise<void>;
    /** start(), then settle the token promise. */
    connect: () => Promise<void>;
    delays: number[];
}

/**
 * Lets the connection's `await token()` resolve.
 *
 * The socket is built after that await, so a test that inspected `sockets`
 * straight after `start()` would see none — not because the connection is
 * broken, but because it has not reached the socket yet.
 */
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

function harness(accessToken = 'token-value'): Harness {
    const sockets: FakeSocket[] = [];
    const states: ConnectionState[] = [];
    const events: LiveEvent[] = [];
    const delays: number[] = [];
    let pending: (() => void) | null = null;

    const connection = new LiveConnection({
        token: async () => accessToken,
        onEvent: (event) => { events.push(event); },
        onStateChange: (state) => { states.push(state); },
        socketFactory: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
        },
        setTimeoutImpl: (fn, ms) => { delays.push(ms); pending = fn; return 1; },
        clearTimeoutImpl: () => { pending = null; },
        // Full jitter at its maximum, so the recorded delay is the cap itself
        // and the backoff curve is readable in the assertions.
        randomImpl: () => 1
    });

    return {
        connection,
        sockets,
        states,
        events,
        delays,
        tick: async () => { const fn = pending; pending = null; fn?.(); await settle(); },
        connect: async () => { connection.start(); await settle(); }
    };
}

describe('LiveConnection', () => {
    it('reports connecting, then open', async () => {
        const h = harness();
        await h.connect();
        expect(h.states).toEqual(['connecting']);

        h.sockets[0]?.open();
        expect(h.states).toEqual(['connecting', 'open']);
        expect(h.connection.currentState).toBe('open');
    });

    it('carries the access token to the live path', async () => {
        const h = harness('a token/with=chars');
        await h.connect();

        expect(h.sockets[0]?.url).toContain('/api/v1/live?access_token=');
        // Escaped, so a token cannot smuggle another query parameter.
        expect(h.sockets[0]?.url).toContain(encodeURIComponent('a token/with=chars'));
    });

    it('speaks ws, not http', async () => {
        const h = harness();
        await h.connect();
        expect(h.sockets[0]?.url.startsWith('ws')).toBe(true);
    });

    it('reports reconnecting on the first drops, and down once it is a real outage', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.open();

        h.sockets[0]?.drop();
        expect(h.connection.currentState).toBe('reconnecting');

        await h.tick();
        h.sockets[1]?.drop();
        expect(h.connection.currentState).toBe('reconnecting');

        await h.tick();
        h.sockets[2]?.drop();
        // Three consecutive failures is no longer a blip.
        expect(h.connection.currentState).toBe('down');
    });

    it('keeps trying after it has reported down', async () => {
        const h = harness();
        await h.connect();
        for (let i = 0; i < 4; i++) {
            h.sockets[i]?.drop();
            await h.tick();
        }

        expect(h.connection.currentState).toBe('down');
        expect(h.sockets.length).toBeGreaterThan(4);
    });

    it('backs off exponentially, capped', async () => {
        const h = harness();
        await h.connect();

        for (let i = 0; i < 8; i++) {
            h.sockets[i]?.drop();
            await h.tick();
        }

        expect(h.delays.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);
        expect(Math.max(...h.delays)).toBeLessThanOrEqual(30_000);
    });

    it('resets the backoff after a successful connection', async () => {
        const h = harness();
        await h.connect();

        h.sockets[0]?.drop();
        await h.tick();
        h.sockets[1]?.drop();
        await h.tick();

        h.sockets[2]?.open();
        h.sockets[2]?.drop();

        // Back to the first rung, not wherever the previous outage got to.
        expect(h.delays[h.delays.length - 1]).toBe(500);
    });

    it('delivers parsed events', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.open();

        h.sockets[0]?.send(JSON.stringify({
            type: 'channel.status', channelId: 'c1', at: '2026-08-16T10:00:00Z',
            live: true, sessionState: 'running'
        }));

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.type).toBe('channel.status');
    });

    it('drops an unreadable frame without dropping the connection', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.open();

        h.sockets[0]?.send('{not json');

        expect(h.events).toHaveLength(0);
        expect(h.connection.currentState).toBe('open');
    });

    it('stops for good, and a late close does not restart it', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.open();

        h.connection.stop();
        expect(h.connection.currentState).toBe('down');
        expect(h.sockets[0]?.closed).toBe(true);

        const before = h.sockets.length;
        h.sockets[0]?.drop();
        await h.tick();
        expect(h.sockets.length).toBe(before);
    });

    it('does not report a state it is already in', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.open();
        h.sockets[0]?.open();

        expect(h.states.filter((s) => s === 'open')).toHaveLength(1);
    });

    it('never emits a state that claims anything about the channel', async () => {
        // The whole 4b guarantee rests on this type staying about the link.
        const h = harness();
        await h.connect();
        h.sockets[0]?.drop();

        const allowed: ConnectionState[] = ['connecting', 'open', 'reconnecting', 'down'];
        for (const state of h.states) expect(allowed).toContain(state);
    });

    it('is safe to stop twice', async () => {
        const h = harness();
        await h.connect();
        h.connection.stop();
        expect(() => { h.connection.stop(); }).not.toThrow();
    });

    it('does not leave handlers attached to a dead socket', async () => {
        const h = harness();
        await h.connect();
        h.sockets[0]?.drop();

        expect(h.sockets[0]?.onclose).toBeNull();
        expect(h.sockets[0]?.onmessage).toBeNull();
    });
});

/**
 * The defect the owner's own machine exhibited.
 *
 * Access tokens live fifteen minutes. The shell captured one at boot and reused
 * it for every reconnect, and a browser WebSocket does not expose the
 * handshake's status code — a rejected upgrade arrives as an ordinary close.
 * So after any drop past the first fifteen minutes the app retried forever with
 * a token the server would never accept, and sat in `4b` claiming it could not
 * reach a server that was perfectly healthy.
 */
describe('the token per attempt', () => {
    it('asks for a token again on every reconnect, not once at the start', async () => {
        const tokens = ['first', 'second', 'third'];
        let issued = 0;
        const sockets: FakeSocket[] = [];

        let pending: (() => void) | null = null;
        const connection = new LiveConnection({
            token: async () => tokens[issued++] ?? 'exhausted',
            onEvent: () => undefined,
            onStateChange: () => undefined,
            socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
            setTimeoutImpl: (fn) => { pending = fn; return 1; },
            clearTimeoutImpl: () => { pending = null; },
            randomImpl: () => 1
        });

        connection.start();
        await Promise.resolve(); await Promise.resolve();
        // `drop()`, not `close()`: close() is the LOCAL teardown, drop() is the
        // server going away, which is what schedules a retry.
        sockets[0]?.drop();

        const retry = pending as (() => void) | null; pending = null; retry?.();
        await Promise.resolve(); await Promise.resolve();

        expect(sockets).toHaveLength(2);
        // The second attempt carries the SECOND token. Reusing the first is
        // what made the reconnect loop unable to heal itself.
        expect(sockets[1]?.url).toContain('second');
        expect(sockets[1]?.url).not.toContain('first');
    });

    it('treats a failed refresh as a drop and keeps trying, rather than giving up', async () => {
        // The refresh can fail because the network is down — which is exactly
        // when reconnecting matters. Ending the session there would sign a user
        // out over a blip.
        let attempts = 0;
        const sockets: FakeSocket[] = [];
        let pending: (() => void) | null = null;

        const connection = new LiveConnection({
            token: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('network down');
                return 'recovered';
            },
            onEvent: () => undefined,
            onStateChange: () => undefined,
            socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
            setTimeoutImpl: (fn) => { pending = fn; return 1; },
            clearTimeoutImpl: () => { pending = null; },
            randomImpl: () => 1
        });

        connection.start();
        await Promise.resolve(); await Promise.resolve();

        // No socket yet, but a retry was scheduled rather than the loop ending.
        expect(sockets).toHaveLength(0);
        expect(pending).not.toBeNull();

        const retry = pending as (() => void) | null; pending = null; retry?.();
        await Promise.resolve(); await Promise.resolve();

        expect(sockets).toHaveLength(1);
        expect(sockets[0]?.url).toContain('recovered');
    });

    it('does not build a socket for a connection stopped mid-refresh', async () => {
        let release: ((token: string) => void) | undefined;
        const sockets: FakeSocket[] = [];

        const connection = new LiveConnection({
            token: () => new Promise<string>((resolve) => { release = resolve; }),
            onEvent: () => undefined,
            onStateChange: () => undefined,
            socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
            setTimeoutImpl: () => 1,
            clearTimeoutImpl: () => undefined
        });

        connection.start();
        connection.stop();
        (release as ((token: string) => void) | undefined)?.('too late');
        await Promise.resolve(); await Promise.resolve();

        expect(sockets).toHaveLength(0);
    });
});
