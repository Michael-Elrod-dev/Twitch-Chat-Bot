import type { Logger } from '../../logger.js';

export interface IngestQueueOptions<T> {
    logger: Logger;
    /** Processes one item. Its rejection is logged and swallowed. */
    worker: (item: T) => Promise<void>;
    /**
     * Backpressure ceiling. Refusing an enqueue is better than growing the heap
     * without limit: Twitch retries a non-2xx, so a refused delivery comes back.
     */
    maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 5_000;

/**
 * The enqueue-and-ack buffer between the webhook endpoint and the sessions.
 *
 * Twitch expects a response "within a few seconds" and revokes subscriptions
 * that repeatedly miss it (docs/TWITCH_PLATFORM_FACTS.md section 3), so the
 * handler must never do real work on the request thread. It writes here and
 * returns, and this drains afterwards.
 *
 * Processing is serial and isolated per item. Chat volume does not need
 * parallelism, ordering is free, and one poisonous event must never stall the
 * queue behind it.
 */
export class IngestQueue<T> {
    private readonly logger: Logger;
    private readonly worker: (item: T) => Promise<void>;
    private readonly maxDepth: number;

    private readonly items: T[] = [];
    private pumping = false;
    private accepting = true;
    private processed = 0;
    private failed = 0;
    private refused = 0;

    /** Resolved by the pump whenever the queue empties, so drain() can await it. */
    private idleWaiters: (() => void)[] = [];

    constructor(options: IngestQueueOptions<T>) {
        this.logger = options.logger;
        this.worker = options.worker;
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    }

    get depth(): number {
        return this.items.length;
    }

    get stats(): { processed: number; failed: number; refused: number; depth: number } {
        return { processed: this.processed, failed: this.failed, refused: this.refused, depth: this.items.length };
    }

    /** @returns false when the item was refused, so the caller can answer 503. */
    enqueue(item: T): boolean {
        if (!this.accepting) {
            this.refused++;
            this.logger.warn('Ingest queue is closed - refusing item');
            return false;
        }

        if (this.items.length >= this.maxDepth) {
            this.refused++;
            this.logger.error({ depth: this.items.length }, 'Ingest queue is full - refusing item');
            return false;
        }

        this.items.push(item);
        void this.pump();
        return true;
    }

    /** Resolves once every queued item has been processed. */
    async drain(): Promise<void> {
        if (this.items.length === 0 && !this.pumping) return;
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }

    /** Stops accepting, then finishes what is already queued. */
    async close(): Promise<void> {
        this.accepting = false;
        await this.drain();
        this.logger.info(this.stats, 'Ingest queue closed');
    }

    private async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;

        try {
            while (this.items.length > 0) {
                const item = this.items.shift() as T;
                try {
                    await this.worker(item);
                    this.processed++;
                } catch (err) {
                    // One bad event must never stall the queue behind it.
                    this.failed++;
                    this.logger.error({ err: (err as Error).message }, 'Ingest worker failed - dropping item');
                }
            }
        } finally {
            this.pumping = false;
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
        }
    }
}
