import { Redis } from 'ioredis';
import type { Logger } from '../logger.js';

export interface RedisHandle {
    client: Redis;
    ping: () => Promise<void>;
    close: () => Promise<void>;
    /** False whenever the client is not currently usable. Never throws. */
    isAvailable: () => boolean;
}

export interface RedisOptions {
    url: string;
    logger: Logger;
}

/**
 * Redis is a cache and a queue, never a source of truth. Every Redis-backed
 * path has a database fallback, so a Redis outage degrades performance and
 * nothing else.
 */
export function createRedis({ url, logger }: RedisOptions): RedisHandle {
    const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        retryStrategy: (times: number) => {
            if (times > 10) {
                logger.error('Redis reconnection attempts exhausted; staying in fallback mode');
                return null;
            }
            return Math.min(times * 500, 5_000);
        }
    });

    let available = false;

    client.on('ready', () => {
        available = true;
        logger.info('Redis ready');
    });
    client.on('end', () => {
        available = false;
        logger.warn('Redis connection ended - fallback mode');
    });
    client.on('error', (err: Error) => {
        available = false;
        logger.warn({ err: err.message }, 'Redis error - fallback mode');
    });

    return {
        client,
        isAvailable: () => available,
        ping: async () => {
            const reply = await client.ping();
            if (reply !== 'PONG') {
                throw new Error(`unexpected ping reply: ${reply}`);
            }
        },
        close: async () => {
            available = false;
            try {
                await client.quit();
            } catch {
                // A failed quit must not block shutdown; drop the socket instead.
                client.disconnect();
            }
        }
    };
}
