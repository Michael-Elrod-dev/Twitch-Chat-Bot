import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import { pino } from 'pino';
import { createShutdownHandler, type Closeable } from './lifecycle.js';

/**
 * A teardown that abandons itself partway leaves the process half-alive. These
 * tests pin the properties that keep that from happening.
 */

const logger = pino({ level: 'silent' });

/** Minimal http.Server stand-in: only close() is exercised. */
const fakeServer = (closeError?: Error): Server =>
    ({
        close: (cb?: (err?: Error) => void) => {
            cb?.(closeError);
            return undefined as unknown as Server;
        }
    }) as unknown as Server;

const closeable = (name: string, impl?: () => Promise<void>): Closeable => ({
    name,
    close: impl ?? (() => Promise.resolve())
});

describe('graceful shutdown', () => {
    it('closes the HTTP server before any dependency', async () => {
        const order: string[] = [];
        const server = {
            close: (cb?: (err?: Error) => void) => {
                order.push('server');
                cb?.();
                return undefined as unknown as Server;
            }
        } as unknown as Server;

        const shutdown = createShutdownHandler({
            server,
            logger,
            closeables: [closeable('db', async () => { order.push('db'); })],
            onExit: () => {}
        });

        await shutdown();

        // New connections must stop arriving before we tear down what in-flight
        // requests still need.
        expect(order).toEqual(['server', 'db']);
    });

    it('closes dependencies in registration order', async () => {
        const order: string[] = [];
        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [
                closeable('redis', async () => { order.push('redis'); }),
                closeable('postgres', async () => { order.push('postgres'); })
            ],
            onExit: () => {}
        });

        await shutdown();

        expect(order).toEqual(['redis', 'postgres']);
    });

    it('exits 0 when everything closes cleanly', async () => {
        const onExit = vi.fn();
        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [closeable('db')],
            onExit
        });

        await shutdown();

        expect(onExit).toHaveBeenCalledWith(0);
    });

    it('continues past a failing dependency and still closes the rest', async () => {
        const later = vi.fn().mockResolvedValue(undefined);
        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [
                closeable('broken', () => Promise.reject(new Error('nope'))),
                closeable('later', later)
            ],
            onExit: () => {}
        });

        await shutdown();

        // One failing step must not abandon the teardown.
        expect(later).toHaveBeenCalled();
    });

    it('exits non-zero when a dependency fails to close', async () => {
        const onExit = vi.fn();
        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [closeable('broken', () => Promise.reject(new Error('nope')))],
            onExit
        });

        await shutdown();

        expect(onExit).toHaveBeenCalledWith(1);
    });

    it('exits non-zero when the server itself fails to close', async () => {
        const onExit = vi.fn();
        const shutdown = createShutdownHandler({
            server: fakeServer(new Error('still listening')),
            logger,
            onExit
        });

        await shutdown();

        expect(onExit).toHaveBeenCalledWith(1);
    });

    it('is idempotent - a second signal does not tear down twice', async () => {
        const close = vi.fn().mockResolvedValue(undefined);
        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [closeable('db', close)],
            onExit: () => {}
        });

        await shutdown();
        await shutdown();

        expect(close).toHaveBeenCalledTimes(1);
    });

    it('works with no dependencies registered', async () => {
        const onExit = vi.fn();
        const shutdown = createShutdownHandler({ server: fakeServer(), logger, onExit });

        await expect(shutdown()).resolves.toBeUndefined();
        expect(onExit).toHaveBeenCalledWith(0);
    });

    it('forces exit when a dependency hangs past the timeout', async () => {
        vi.useFakeTimers();
        const onExit = vi.fn();

        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [closeable('wedged', () => new Promise<void>(() => { /* never settles */ }))],
            timeoutMs: 5_000,
            onExit
        });

        void shutdown();
        await vi.advanceTimersByTimeAsync(5_000);

        // A wedged connection must not hold the process open forever.
        expect(onExit).toHaveBeenCalledWith(1);

        vi.useRealTimers();
    });

    it('does not fire the timeout when shutdown completes in time', async () => {
        vi.useFakeTimers();
        const onExit = vi.fn();

        const shutdown = createShutdownHandler({
            server: fakeServer(),
            logger,
            closeables: [closeable('quick')],
            timeoutMs: 5_000,
            onExit
        });

        await shutdown();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onExit).toHaveBeenCalledWith(0);

        vi.useRealTimers();
    });
});
