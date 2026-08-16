import type { Server } from 'node:http';
import type { Logger } from './logger.js';

/** Something that must be closed on the way down, in registration order. */
export interface Closeable {
    name: string;
    close: () => Promise<void>;
}

export interface ShutdownOptions {
    server: Server;
    logger: Logger;
    closeables?: Closeable[];
    /** Hard ceiling before we stop being polite. */
    timeoutMs?: number;
    onExit?: (code: number) => void;
}

/**
 * Graceful shutdown, carrying Phase 0's discipline forward:
 *  - idempotent (a second signal is ignored, not a second teardown),
 *  - every step isolated so one failure cannot abandon the rest,
 *  - a timeout so a wedged connection cannot hang the process forever.
 */
export function createShutdownHandler(options: ShutdownOptions): () => Promise<void> {
    const { server, logger, closeables = [], timeoutMs = 10_000, onExit = (code) => process.exit(code) } = options;

    let shuttingDown = false;

    return async function shutdown(): Promise<void> {
        if (shuttingDown) {
            logger.warn('Shutdown already in progress, ignoring duplicate signal');
            return;
        }
        shuttingDown = true;

        logger.info('Graceful shutdown started');

        const timer = setTimeout(() => {
            logger.error({ timeoutMs }, 'Shutdown timed out, forcing exit');
            onExit(1);
        }, timeoutMs);
        // Do not keep the loop alive purely for the watchdog.
        timer.unref?.();

        let failed = false;

        // Stop accepting new connections before tearing down what in-flight
        // requests still depend on.
        await new Promise<void>((resolve) => {
            server.close((err) => {
                if (err) {
                    failed = true;
                    logger.error({ err }, 'Error closing HTTP server');
                }
                resolve();
            });
        });
        logger.info('HTTP server closed');

        for (const closeable of closeables) {
            try {
                await closeable.close();
                logger.info({ resource: closeable.name }, 'Closed');
            } catch (err) {
                failed = true;
                logger.error({ err, resource: closeable.name }, 'Error closing resource');
            }
        }

        clearTimeout(timer);
        logger.info('Graceful shutdown complete');
        onExit(failed ? 1 : 0);
    };
}

export function installSignalHandlers(shutdown: () => Promise<void>, logger: Logger): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            logger.info({ signal }, 'Signal received');
            void shutdown();
        });
    }

    process.on('unhandledRejection', (reason) => {
        logger.error({ reason }, 'Unhandled promise rejection');
    });

    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'Uncaught exception');
        void shutdown();
    });
}
