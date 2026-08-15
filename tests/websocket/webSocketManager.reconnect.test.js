/**
 * Reconnect behaviour (P0-2a/b).
 *
 * Twitch EventSub protocol: a session_reconnect message carries a reconnect_url.
 * The client opens a NEW socket to that URL, keeps the old one until the new one
 * sends session_welcome, then closes the old one. Subscriptions transfer with the
 * session, so this path must NOT resubscribe. Any other close is unexpected and
 * needs a reconnect plus a full resubscribe.
 */

const WebSocketManager = require('../../src/websocket/webSocketManager');

jest.mock('ws');

jest.mock('../../src/config/config', () => ({
    wsEndpoint: 'wss://eventsub.wss.twitch.tv/ws',
    wsReconnectDelay: 5000
}));

const WebSocket = require('ws');

const RECONNECT_URL = 'wss://eventsub.wss.twitch.tv/ws?challenge=abc';

const sessionWelcome = (id) => ({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id } }
});

const sessionReconnect = (reconnectUrl) => ({
    metadata: { message_type: 'session_reconnect' },
    payload: { session: { id: 'old-session', reconnect_url: reconnectUrl } }
});

describe('WebSocketManager - reconnect lifecycle', () => {
    let manager;
    let sockets;
    let onSessionReady;
    let onSessionMoved;

    const makeSocket = (url) => {
        const listeners = {};
        const socket = {
            url,
            close: jest.fn(),
            on: jest.fn((event, handler) => {
                listeners[event] = handler;
            }),
            fireClose: (code = 1006, reason = Buffer.from('gone')) =>
                listeners.close && listeners.close(code, reason),
            deliver: (message) => listeners.message && listeners.message(JSON.stringify(message))
        };
        sockets.push(socket);
        return socket;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        sockets = [];
        WebSocket.mockImplementation((url) => makeSocket(url));

        onSessionReady = jest.fn().mockResolvedValue(undefined);
        onSessionMoved = jest.fn().mockResolvedValue(undefined);

        manager = new WebSocketManager({
            tokenManager: { tokens: { clientId: 'c', broadcasterAccessToken: 't' } },
            onChatMessage: jest.fn(),
            onRedemption: jest.fn(),
            onStreamOnline: jest.fn(),
            onStreamOffline: jest.fn()
        });
        manager.onSessionReady = onSessionReady;
        manager.onSessionMoved = onSessionMoved;
    });

    afterEach(() => {
        manager.clearReconnectTimer();
        jest.useRealTimers();
    });

    describe('session_reconnect (reconnect_url path)', () => {
        beforeEach(async () => {
            await manager.connect();
            await manager.handleMessage(sessionWelcome('session-1'), sockets[0]);
            onSessionReady.mockClear();
        });

        it('should open a new socket to the reconnect_url', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            expect(WebSocket).toHaveBeenCalledTimes(2);
            expect(WebSocket).toHaveBeenLastCalledWith(RECONNECT_URL);
            expect(manager.pendingConnection).toBe(sockets[1]);
        });

        it('should keep the old socket open until the new session welcomes', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            expect(sockets[0].close).not.toHaveBeenCalled();
            expect(manager.wsConnection).toBe(sockets[0]);
        });

        it('should promote the new socket and retire the old one on welcome', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);
            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);

            expect(manager.wsConnection).toBe(sockets[1]);
            expect(manager.pendingConnection).toBeNull();
            expect(manager.sessionId).toBe('session-2');
            expect(sockets[0].close).toHaveBeenCalled();
        });

        it('should NOT resubscribe on a carried-over session', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);
            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);

            expect(onSessionReady).not.toHaveBeenCalled();
            expect(onSessionMoved).toHaveBeenCalledWith('session-2');
        });

        it('should not reconnect when the replaced socket closes', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);
            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);

            sockets[0].fireClose(1000, Buffer.from('replaced'));
            jest.advanceTimersByTime(60000);

            // Still just the two sockets - no third connection was opened.
            expect(WebSocket).toHaveBeenCalledTimes(2);
            expect(manager.wsConnection).toBe(sockets[1]);
        });

        it('should ignore a session_reconnect with no reconnect_url', async () => {
            await manager.handleMessage(sessionReconnect(undefined), sockets[0]);

            expect(WebSocket).toHaveBeenCalledTimes(1);
            expect(manager.pendingConnection).toBeNull();
        });

        it('should ignore a second reconnect while one is in flight', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            expect(WebSocket).toHaveBeenCalledTimes(2);
        });

        it('should cancel the reconnect armed by the old socket dying mid-migration', async () => {
            // Twitch closes the old socket with 4004 if the migration takes >30s, so
            // it can die before the replacement welcomes. Its close arms a reconnect;
            // promoting the replacement must cancel it, or the timer later overwrites
            // the healthy socket and resubscribes on a second live session.
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            sockets[0].fireClose(4004, Buffer.from('reconnect grace time expired'));
            expect(manager.reconnectTimer).not.toBeNull();

            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);

            expect(manager.reconnectTimer).toBeNull();

            jest.advanceTimersByTime(60000);

            // No third socket: the orphaned reconnect never fired.
            expect(WebSocket).toHaveBeenCalledTimes(2);
            expect(manager.wsConnection).toBe(sockets[1]);
            expect(onSessionReady).not.toHaveBeenCalled();
        });

        it('should keep the current connection if the replacement dies before welcome', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            sockets[1].fireClose(1006, Buffer.from('failed'));
            jest.advanceTimersByTime(60000);

            expect(manager.pendingConnection).toBeNull();
            expect(manager.wsConnection).toBe(sockets[0]);
            expect(WebSocket).toHaveBeenCalledTimes(2);
        });
    });

    describe('unexpected close', () => {
        beforeEach(async () => {
            await manager.connect();
            await manager.handleMessage(sessionWelcome('session-1'), sockets[0]);
            onSessionReady.mockClear();
        });

        it('should reconnect to the standard endpoint after the delay', () => {
            sockets[0].fireClose();

            expect(WebSocket).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(5000);

            expect(WebSocket).toHaveBeenCalledTimes(2);
            expect(WebSocket).toHaveBeenLastCalledWith('wss://eventsub.wss.twitch.tv/ws');
        });

        it('should not reconnect before the delay elapses', () => {
            sockets[0].fireClose();

            jest.advanceTimersByTime(4999);

            expect(WebSocket).toHaveBeenCalledTimes(1);
        });

        it('should fully resubscribe once the new session welcomes', async () => {
            sockets[0].fireClose();
            jest.advanceTimersByTime(5000);

            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);

            expect(onSessionReady).toHaveBeenCalledWith('session-2');
            expect(onSessionMoved).not.toHaveBeenCalled();
        });

        it('should schedule only one reconnect for a single close', () => {
            sockets[0].fireClose();

            jest.advanceTimersByTime(30000);

            expect(WebSocket).toHaveBeenCalledTimes(2);
        });

        it('should ignore a close from a stale socket', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);
            await manager.handleMessage(sessionWelcome('session-2'), sockets[1]);
            sockets[0].close.mockClear();

            // A socket that is neither current nor pending must not trigger anything.
            const stale = makeSocket('wss://stale');
            manager.attachHandlers(stale);
            stale.fireClose();
            jest.advanceTimersByTime(60000);

            expect(manager.wsConnection).toBe(sockets[1]);
        });
    });

    describe('intentional close', () => {
        beforeEach(async () => {
            await manager.connect();
            await manager.handleMessage(sessionWelcome('session-1'), sockets[0]);
        });

        it('should close the active socket', () => {
            manager.close();

            expect(sockets[0].close).toHaveBeenCalled();
        });

        it('should not reconnect after an intentional close', () => {
            manager.close();
            sockets[0].fireClose(1000, Buffer.from('bye'));

            jest.advanceTimersByTime(60000);

            expect(WebSocket).toHaveBeenCalledTimes(1);
        });

        it('should cancel a reconnect already scheduled by an earlier drop', () => {
            sockets[0].fireClose();

            manager.close();
            jest.advanceTimersByTime(60000);

            expect(WebSocket).toHaveBeenCalledTimes(1);
        });

        it('should also close a replacement socket that is still pending', async () => {
            await manager.handleMessage(sessionReconnect(RECONNECT_URL), sockets[0]);

            manager.close();

            expect(sockets[0].close).toHaveBeenCalled();
            expect(sockets[1].close).toHaveBeenCalled();
            expect(manager.pendingConnection).toBeNull();
        });

        it('should not throw when a socket close call fails', () => {
            sockets[0].close.mockImplementation(() => {
                throw new Error('already closed');
            });

            expect(() => manager.close()).not.toThrow();
        });
    });

    describe('reconnect after an intentional close is followed by a fresh connect', () => {
        it('should allow reconnecting again after close then connect', async () => {
            await manager.connect();
            manager.close();

            await manager.connect();
            sockets[1].fireClose();
            jest.advanceTimersByTime(5000);

            expect(WebSocket).toHaveBeenCalledTimes(3);
        });
    });
});
