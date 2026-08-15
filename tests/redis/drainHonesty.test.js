/**
 * P1-11: an unreadable queue length must never read as drained.
 */

describe('P1-11: drain never reports a false success', () => {
    const QueueManager = require('../../src/redis/queueManager');

    let queueManager;
    let client;

    beforeEach(() => {
        jest.useFakeTimers();
        client = { llen: jest.fn() };
        queueManager = new QueueManager(
            { connected: () => true, getClient: () => client },
            {}
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should report an unreadable length as unknown', async () => {
        client.llen.mockRejectedValue(new Error('Redis gone'));

        await expect(queueManager.getQueueLength('q')).resolves.toBeNull();
    });

    it('should mark a measurement unknown when any length fails', async () => {
        client.llen
            .mockResolvedValueOnce(0)
            .mockRejectedValueOnce(new Error('Redis gone'));

        const result = await queueManager.measureQueues(['a', 'b']);

        expect(result.unknown).toBe(true);
    });

    it('should report drained only when every length really is zero', async () => {
        client.llen.mockResolvedValue(0);

        const result = await queueManager.drainQueues(5000);

        expect(result).toMatchObject({ drained: true, timedOut: false });
    });

    it('should NOT report drained when lengths are unreadable', async () => {
        client.llen.mockRejectedValue(new Error('Redis gone'));

        const drain = queueManager.drainQueues(2000);
        await jest.advanceTimersByTimeAsync(3000);
        const result = await drain;

        // Returning 0 on error made a dead Redis look identical to a drained queue,
        // and the shutdown backup would then claim to include everything.
        expect(result.drained).toBe(false);
        expect(result.unknown).toBe(true);
    });

    it('should time out honestly with messages still queued', async () => {
        client.llen.mockResolvedValue(7);

        const drain = queueManager.drainQueues(2000);
        await jest.advanceTimersByTimeAsync(3000);
        const result = await drain;

        expect(result).toMatchObject({ drained: false, timedOut: true });
        expect(result.remaining).toBeGreaterThan(0);
    });

    it('should report drained when Redis is not in use at all', async () => {
        const offline = new QueueManager({ connected: () => false, getClient: () => null }, {});

        await expect(offline.drainQueues(1000)).resolves.toMatchObject({ drained: true });
    });
});
