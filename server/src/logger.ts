import { pino, type Logger } from 'pino';
import type { Env } from './config/env.js';

/**
 * Structured JSON logs in production, so they are machine-parseable wherever
 * they are shipped, and human-readable logs in development.
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
