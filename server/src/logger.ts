import { pino, type Logger } from 'pino';
import type { Env } from './config/env.js';

/**
 * Structured JSON logs in production (machine-parseable, ships to whatever we
 * point at it); human-readable in development. Replaced Phase 0's winston, which
 * was deleted with the rest of the legacy tree in P1-LR.
 */
export function createLogger(env: Env): Logger {
    const isDev = env.NODE_ENV === 'development';

    return pino({
        level: env.LOG_LEVEL,
        // Never let a stray secret reach the log sink.
        redact: {
            paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'password',
                'token',
                'accessToken',
                'refreshToken',
                'clientSecret'
            ],
            censor: '[redacted]'
        },
        ...(isDev
            ? {
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
                }
            }
            : {})
    });
}

export type { Logger };
