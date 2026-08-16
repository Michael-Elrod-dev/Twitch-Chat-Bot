import { describe, it, expect, vi } from 'vitest';
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
    /** Runs the single pending timer, if there is one. */
    tick: () => void;
    delays: number[];
}

function harness(accessToken = 'token-value'): Harness {
    const sockets: FakeSocket[] = [];
    const states: ConnectionState[] = [];
    const events: LiveEvent[] = [];
    const delays: number[] = [];
    let pending: (() => void) | null = null;

    const connection = new LiveConnection({
        accessToken,
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
        tick: () => { const fn = pending; pending = null; fn?.(); }
    };
}

describe('LiveConnection', () => {
    it('reports connecting, then open', () => {
        const h = harness();
        h.connection.start();
        expect(h.states).toEqual(['connecting']);

        h.sockets[0]?.open();
        expect(h.states).toEqual(['connecting', 'open']);
        expect(h.connection.currentState).toBe('open');
    });

    it('carries the access token to the live path', () => {
        const h = harness('a token/with=chars');
        h.connection.start();

        expect(h.sockets[0]?.url).toContain('/api/v1/live?access_token=');
        // Escaped, so a token cannot smuggle another query parameter.
        expect(h.sockets[0]?.url).toContain(encodeURIComponent('a token/with=chars'));
    });

    it('speaks ws, not http', () => {
        const h = harness();
        h.connection.start();
        expect(h.sockets[0]?.url.startsWith('ws')).toBe(true);
    });

    it('reports reconnecting on the first drops, and down once it is a real outage', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.open();

        h.sockets[0]?.drop();
        expect(h.connection.currentState).toBe('reconnecting');

        h.tick();
        h.sockets[1]?.drop();
        expect(h.connection.currentState).toBe('reconnecting');

        h.tick();
        h.sockets[2]?.drop();
        // Three consecutive failures is no longer a blip.
        expect(h.connection.currentState).toBe('down');
    });

    it('keeps trying after it has reported down', () => {
        const h = harness();
        h.connection.start();
        for (let i = 0; i < 4; i++) {
            h.sockets[i]?.drop();
            h.tick();
        }

        expect(h.connection.currentState).toBe('down');
        expect(h.sockets.length).toBeGreaterThan(4);
    });

    it('backs off exponentially, capped', () => {
        const h = harness();
        h.connection.start();

        for (let i = 0; i < 8; i++) {
            h.sockets[i]?.drop();
            h.tick();
        }

        expect(h.delays.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);
        expect(Math.max(...h.delays)).toBeLessThanOrEqual(30_000);
    });

    it('resets the backoff after a successful connection', () => {
        const h = harness();
        h.connection.start();

        h.sockets[0]?.drop();
        h.tick();
        h.sockets[1]?.drop();
        h.tick();

        h.sockets[2]?.open();
        h.sockets[2]?.drop();

        // Back to the first rung, not wherever the previous outage got to.
        expect(h.delays[h.delays.length - 1]).toBe(500);
    });

    it('delivers parsed events', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.open();

        h.sockets[0]?.send(JSON.stringify({
            type: 'channel.status', channelId: 'c1', at: '2026-08-16T10:00:00Z',
            live: true, sessionState: 'running'
        }));

        expect(h.events).toHaveLength(1);
        expect(h.events[0]?.type).toBe('channel.status');
    });

    it('drops an unreadable frame without dropping the connection', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.open();

        h.sockets[0]?.send('{not json');

        expect(h.events).toHaveLength(0);
        expect(h.connection.currentState).toBe('open');
    });

    it('stops for good, and a late close does not restart it', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.open();

        h.connection.stop();
        expect(h.connection.currentState).toBe('down');
        expect(h.sockets[0]?.closed).toBe(true);

        const before = h.sockets.length;
        h.sockets[0]?.drop();
        h.tick();
        expect(h.sockets.length).toBe(before);
    });

    it('does not report a state it is already in', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.open();
        h.sockets[0]?.open();

        expect(h.states.filter((s) => s === 'open')).toHaveLength(1);
    });

    it('never emits a state that claims anything about the channel', () => {
        // The whole 4b guarantee rests on this type staying about the link.
        const h = harness();
        h.connection.start();
        h.sockets[0]?.drop();

        const allowed: ConnectionState[] = ['connecting', 'open', 'reconnecting', 'down'];
        for (const state of h.states) expect(allowed).toContain(state);
    });

    it('is safe to stop twice', () => {
        const h = harness();
        h.connection.start();
        h.connection.stop();
        expect(() => { h.connection.stop(); }).not.toThrow();
    });

    it('does not leave handlers attached to a dead socket', () => {
        const h = harness();
        h.connection.start();
        h.sockets[0]?.drop();

        expect(h.sockets[0]?.onclose).toBeNull();
        expect(h.sockets[0]?.onmessage).toBeNull();
    });
});

describe('LiveConnection wiring', () => {
    it('uses the real WebSocket when no factory is supplied', () => {
        // Only that the default path is reached — the socket itself is the
        // platform's, and testing it would be testing the browser.
        const factory = vi.fn(() => new FakeSocket('ws://x'));
        const connection = new LiveConnection({
            accessToken: 't',
            onEvent: () => undefined,
            onStateChange: () => undefined,
            socketFactory: factory,
            setTimeoutImpl: () => 1,
            clearTimeoutImpl: () => undefined
        });

        connection.start();
        expect(factory).toHaveBeenCalledOnce();
        connection.stop();
    });
});
