/**
 * Behaviour-equivalence tests for the WP-7 hot-path trims. Each block asserts the
 * observable result is unchanged AND that the work actually went down, so a future
 * "optimisation" that quietly changes semantics fails here.
 */

const QueueManager = require('../../src/redis/queueManager');
const CacheManager = require('../../src/redis/cacheManager');
const AnalyticsQueueConsumer = require('../../src/redis/analyticsQueueConsumer');
const { createMockDbManager } = require('../__mocks__/mockDbManager');

describe('Hot path: counted LPOP', () => {
    let queueManager;
    let client;

    beforeEach(() => {
        client = { lpop: jest.fn() };
        queueManager = new QueueManager(
            { connected: () => true, getClient: () => client },
            {}
        );
    });

    it('should fetch a batch in ONE round trip', async () => {
        client.lpop.mockResolvedValue([
            JSON.stringify({ data: { a: 1 }, attempts: 0 }),
            JSON.stringify({ data: { a: 2 }, attempts: 0 })
        ]);

        const result = await queueManager.pop('analytics:chat_messages', 50);

        // Previously 50 sequential LPOPs every 5 seconds.
        expect(client.lpop).toHaveBeenCalledTimes(1);
        expect(client.lpop).toHaveBeenCalledWith('queue:analytics:chat_messages', 50);
        expect(result).toHaveLength(2);
        expect(result[0].data).toEqual({ a: 1 });
    });

    it('should still use a single LPOP for count 1', async () => {
        client.lpop.mockResolvedValue(JSON.stringify({ data: { a: 1 }, attempts: 0 }));

        const result = await queueManager.pop('q');

        expect(client.lpop).toHaveBeenCalledWith('queue:q');
        expect(result).toHaveLength(1);
    });

    it('should return an empty array when the queue is empty', async () => {
        client.lpop.mockResolvedValue(null);

        await expect(queueManager.pop('q', 10)).resolves.toEqual([]);
    });

    it('should fall back to single pops on a pre-6.2 server', async () => {
        client.lpop
            .mockRejectedValueOnce(new Error('ERR wrong number of arguments for lpop'))
            .mockResolvedValueOnce(JSON.stringify({ data: { a: 1 }, attempts: 0 }))
            .mockResolvedValueOnce(JSON.stringify({ data: { a: 2 }, attempts: 0 }))
            .mockResolvedValueOnce(null);

        const result = await queueManager.pop('q', 5);

        expect(result).toHaveLength(2);
        expect(queueManager.supportsCountedLpop).toBe(false);
    });

    it('should not retry the counted form once it is known unsupported', async () => {
        queueManager.supportsCountedLpop = false;
        client.lpop
            .mockResolvedValueOnce(JSON.stringify({ data: { a: 1 }, attempts: 0 }))
            .mockResolvedValueOnce(null);

        await queueManager.pop('q', 5);

        expect(client.lpop).not.toHaveBeenCalledWith('queue:q', 5);
    });

    it('should skip unparseable entries without losing the rest', async () => {
        client.lpop.mockResolvedValue([
            JSON.stringify({ data: { a: 1 }, attempts: 0 }),
            'not json',
            JSON.stringify({ data: { a: 3 }, attempts: 0 })
        ]);

        const result = await queueManager.pop('q', 3);

        expect(result).toHaveLength(2);
    });
});

describe('Hot path: cache-miss detection', () => {
    let cacheManager;
    let client;

    beforeEach(() => {
        client = {
            exists: jest.fn().mockResolvedValue(1),
            hgetall: jest.fn()
        };
        cacheManager = new CacheManager({
            connected: () => true,
            getClient: () => client
        });
    });

    it('should report a populated key without pulling its contents', async () => {
        await expect(cacheManager.exists('cache:commands')).resolves.toBe(true);

        // The point of the trim: no hgetall on the miss path.
        expect(client.hgetall).not.toHaveBeenCalled();
    });

    it('should report an absent key', async () => {
        client.exists.mockResolvedValue(0);

        await expect(cacheManager.exists('cache:commands')).resolves.toBe(false);
    });

    it('should report false when Redis errors', async () => {
        client.exists.mockRejectedValue(new Error('Redis down'));

        await expect(cacheManager.exists('cache:commands')).resolves.toBe(false);
    });

    it('should report false when Redis is unavailable', async () => {
        const offline = new CacheManager({ connected: () => false, getClient: () => null });

        await expect(offline.exists('cache:commands')).resolves.toBe(false);
    });
});

describe('Hot path: batched analytics insert', () => {
    let consumer;
    let dbManager;
    let queueManager;

    const rows = (n) => Array.from({ length: n }, (_, i) => ({
        userId: `u${i}`,
        streamId: 's1',
        messageType: 'message',
        content: `m${i}`,
        messageTime: new Date('2026-01-01T00:00:00Z')
    }));

    beforeEach(() => {
        dbManager = createMockDbManager({ defaultQueryResult: { affectedRows: 1 } });
        queueManager = {
            pop: jest.fn().mockResolvedValue([]),
            requeueWithRetry: jest.fn(),
            moveToDLQ: jest.fn()
        };
        consumer = new AnalyticsQueueConsumer(queueManager, dbManager);
    });

    it('should insert a batch as one multi-row statement', async () => {
        await expect(consumer.insertChatMessageBatch(rows(3))).resolves.toBe(true);

        expect(dbManager.withTransaction).toHaveBeenCalledTimes(1);
        expect(dbManager._transaction.query).toHaveBeenCalledTimes(1);

        const [sql, params] = dbManager._transaction.query.mock.calls[0];
        expect(sql).toContain('(?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)');
        // Same five columns per row as the row-by-row form.
        expect(params).toHaveLength(15);
    });

    it('should preserve column order and values', async () => {
        await consumer.insertChatMessageBatch(rows(1).concat(rows(1)));

        const [, params] = dbManager._transaction.query.mock.calls[0];
        expect(params.slice(0, 5)).toEqual([
            'u0', 's1', new Date('2026-01-01T00:00:00Z'), 'message', 'm0'
        ]);
    });

    it('should treat an empty batch as a no-op success', async () => {
        await expect(consumer.insertChatMessageBatch([])).resolves.toBe(true);

        expect(dbManager.withTransaction).not.toHaveBeenCalled();
    });

    it('should decline a single row so the fallback owns it exclusively', async () => {
        // Attempting it here too would double-attempt a failing insert.
        await expect(consumer.insertChatMessageBatch(rows(1))).resolves.toBe(false);

        expect(dbManager.withTransaction).not.toHaveBeenCalled();
    });

    it('should decline when the db manager predates withTransaction', async () => {
        consumer.dbManager = { query: jest.fn() };

        await expect(consumer.insertChatMessageBatch(rows(3))).resolves.toBe(false);
    });

    it('should produce the same rows as the row-by-row path', async () => {
        const batch = rows(2);

        await consumer.insertChatMessageBatch(batch);
        const [, batchParams] = dbManager._transaction.query.mock.calls[0];

        dbManager.query.mockClear();
        await consumer.insertChatMessage(batch[0]);
        await consumer.insertChatMessage(batch[1]);
        const rowParams = dbManager.query.mock.calls.flatMap(([, params]) => params);

        expect(batchParams).toEqual(rowParams);
    });

    it('should fall back per-row when the batch fails, preserving attribution', async () => {
        queueManager.pop
            .mockResolvedValueOnce([
                { data: rows(1)[0], attempts: 0 },
                { data: rows(2)[1], attempts: 5 }
            ])
            .mockResolvedValue([]);
        dbManager.withTransaction.mockRejectedValue(new Error('Deadlock'));
        dbManager.query
            .mockResolvedValueOnce({ affectedRows: 1 })
            .mockRejectedValueOnce(new Error('Row failed'));

        await consumer.processChatMessages();

        // The over-retried message goes to the DLQ; the other one succeeded.
        expect(queueManager.moveToDLQ).toHaveBeenCalledTimes(1);
        expect(queueManager.requeueWithRetry).not.toHaveBeenCalled();
    });
});
