import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { IngestQueue } from './ingestQueue.js';

const logger = pino({ level: 'silent' });

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

describe('IngestQueue', () => {
    it('processes enqueued items', async () => {
        const seen: number[] = [];
        const queue = new IngestQueue<number>({ logger, worker: async (n) => { seen.push(n); } });

        queue.enqueue(1);
        queue.enqueue(2);
        await queue.drain();

        expect(seen).toEqual([1, 2]);
    });

    it('returns from enqueue before the item is processed', async () => {
        // The whole reason the queue exists: Twitch expects an answer in
        // seconds, so the request thread must not wait on the work.
        const gate = deferred<void>();
        const queue = new IngestQueue<number>({ logger, worker: async () => { await gate.promise; } });

        queue.enqueue(1);

        expect(queue.depth).toBe(0); // taken by the pump, not yet finished
        gate.resolve();
        await queue.drain();
    });

    it('preserves order', async () => {
        const seen: number[] = [];
        const queue = new IngestQueue<number>({
            logger,
            worker: async (n) => {
                await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
                seen.push(n);
            }
        });

        queue.enqueue(1);
        queue.enqueue(2);
        queue.enqueue(3);
        await queue.drain();

        expect(seen).toEqual([1, 2, 3]);
    });

    it('keeps going after an item throws', async () => {
        // One poisonous event must never stall everything queued behind it.
        const seen: number[] = [];
        const queue = new IngestQueue<number>({
            logger,
            worker: async (n) => {
                if (n === 2) throw new Error('bad event');
                seen.push(n);
            }
        });

        queue.enqueue(1);
        queue.enqueue(2);
        queue.enqueue(3);
        await queue.drain();

        expect(seen).toEqual([1, 3]);
        expect(queue.stats).toMatchObject({ processed: 2, failed: 1 });
    });

    describe('backpressure', () => {
        it('refuses an item once full', () => {
            const queue = new IngestQueue<number>({
                logger,
                maxDepth: 2,
                worker: async () => new Promise(() => undefined) // never settles
            });

            expect(queue.enqueue(1)).toBe(true); // taken by the pump
            expect(queue.enqueue(2)).toBe(true);
            expect(queue.enqueue(3)).toBe(true);
            expect(queue.enqueue(4)).toBe(false);
            expect(queue.stats.refused).toBe(1);
        });
    });

    describe('drain', () => {
        it('resolves immediately on an idle queue', async () => {
            const queue = new IngestQueue<number>({ logger, worker: async () => undefined });

            await expect(queue.drain()).resolves.toBeUndefined();
        });

        it('waits for in-flight work', async () => {
            const gate = deferred<void>();
            const done = vi.fn();
            const queue = new IngestQueue<number>({
                logger,
                worker: async () => { await gate.promise; done(); }
            });

            queue.enqueue(1);
            const draining = queue.drain();

            expect(done).not.toHaveBeenCalled();
            gate.resolve();
            await draining;
            expect(done).toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('drains what is queued, then refuses more', async () => {
            // Shutdown must not drop events Twitch already believes were accepted.
            const seen: number[] = [];
            const queue = new IngestQueue<number>({
                logger,
                worker: async (n) => { await new Promise((r) => setTimeout(r, 5)); seen.push(n); }
            });

            queue.enqueue(1);
            queue.enqueue(2);
            await queue.close();

            expect(seen).toEqual([1, 2]);
            expect(queue.enqueue(3)).toBe(false);
        });

        it('is safe on a queue that never ran', async () => {
            const queue = new IngestQueue<number>({ logger, worker: async () => undefined });

            await expect(queue.close()).resolves.toBeUndefined();
        });
    });
});
