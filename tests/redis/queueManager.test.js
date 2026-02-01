// tests/redis/queueManager.test.js

const QueueManager = require('../../src/redis/queueManager');

jest.mock('../../src/config/config', () => ({
    analyticsQueue: {
        drainTimeoutMs: 30000
    }
}));

jest.mock('../../src/redis/analyticsQueueConsumer');

const AnalyticsQueueConsumer = require('../../src/redis/analyticsQueueConsumer');

describe('QueueManager', () => {
    let queueManager;
    let mockRedisManager;
    let mockDbManager;
    let mockClient;
    let mockAnalyticsConsumer;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockClient = {
            rpush: jest.fn().mockResolvedValue(1),
            lpush: jest.fn().mockResolvedValue(1),
            lpop: jest.fn(),
            llen: jest.fn().mockResolvedValue(0)
        };

        mockRedisManager = {
            connected: jest.fn().mockReturnValue(true),
            getClient: jest.fn().mockReturnValue(mockClient)
        };

        mockDbManager = {
            query: jest.fn()
        };

        mockAnalyticsConsumer = {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined)
        };

        AnalyticsQueueConsumer.mockImplementation(() => mockAnalyticsConsumer);

        queueManager = new QueueManager(mockRedisManager, mockDbManager);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with correct properties', () => {
            expect(queueManager.redisManager).toBe(mockRedisManager);
            expect(queueManager.dbManager).toBe(mockDbManager);
            expect(queueManager.consumerRunning).toBe(false);
            expect(queueManager.analyticsConsumer).toBeNull();
        });
    });

    describe('isAvailable', () => {
        it('should return true when Redis is connected', () => {
            expect(queueManager.isAvailable()).toBe(true);
        });

        it('should return false when Redis is not connected', () => {
            mockRedisManager.connected.mockReturnValue(false);

            expect(queueManager.isAvailable()).toBe(false);
        });

        it('should return false when redisManager is null', () => {
            queueManager = new QueueManager(null, mockDbManager);

            expect(queueManager.isAvailable()).toBeFalsy();
        });
    });

    describe('getClient', () => {
        it('should return client when available', () => {
            expect(queueManager.getClient()).toBe(mockClient);
        });

        it('should return null when Redis is not available', () => {
            mockRedisManager.connected.mockReturnValue(false);

            expect(queueManager.getClient()).toBeNull();
        });
    });

    describe('push', () => {
        it('should push message to queue with metadata', async () => {
            const message = { type: 'test', data: 'value' };

            const result = await queueManager.push('test-queue', message);

            expect(result).toBe(true);
            expect(mockClient.rpush).toHaveBeenCalledWith(
                'queue:test-queue',
                expect.stringContaining('"data":{"type":"test","data":"value"}')
            );

            const pushArg = JSON.parse(mockClient.rpush.mock.calls[0][1]);
            expect(pushArg).toMatchObject({
                data: message,
                attempts: 0
            });
            expect(pushArg.timestamp).toBeDefined();
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await queueManager.push('queue', { data: 'test' });

            expect(result).toBe(false);
            expect(mockClient.rpush).not.toHaveBeenCalled();
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.rpush.mockRejectedValue(new Error('Push failed'));

            const result = await queueManager.push('queue', { data: 'test' });

            expect(result).toBe(false);
        });
    });

    describe('pop', () => {
        it('should pop single message from queue by default', async () => {
            mockClient.lpop
                .mockResolvedValueOnce('{"data":{"type":"test"},"timestamp":123,"attempts":0}')
                .mockResolvedValueOnce(null);

            const result = await queueManager.pop('test-queue');

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                data: { type: 'test' },
                timestamp: 123,
                attempts: 0
            });
            expect(mockClient.lpop).toHaveBeenCalledWith('queue:test-queue');
        });

        it('should pop multiple messages when count specified', async () => {
            mockClient.lpop
                .mockResolvedValueOnce('{"data":"msg1","timestamp":1,"attempts":0}')
                .mockResolvedValueOnce('{"data":"msg2","timestamp":2,"attempts":0}')
                .mockResolvedValueOnce('{"data":"msg3","timestamp":3,"attempts":0}')
                .mockResolvedValueOnce(null);

            const result = await queueManager.pop('queue', 5);

            expect(result).toHaveLength(3);
            expect(result[0].data).toBe('msg1');
            expect(result[1].data).toBe('msg2');
            expect(result[2].data).toBe('msg3');
        });

        it('should return empty array when queue is empty', async () => {
            mockClient.lpop.mockResolvedValue(null);

            const result = await queueManager.pop('empty-queue');

            expect(result).toEqual([]);
        });

        it('should return empty array when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await queueManager.pop('queue');

            expect(result).toEqual([]);
        });

        it('should handle JSON parse errors gracefully', async () => {
            mockClient.lpop
                .mockResolvedValueOnce('{"valid":"message","attempts":0}')
                .mockResolvedValueOnce('invalid json')
                .mockResolvedValueOnce(null);

            const result = await queueManager.pop('queue', 3);

            expect(result).toHaveLength(1);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.lpop.mockRejectedValue(new Error('Pop failed'));

            const result = await queueManager.pop('queue');

            expect(result).toEqual([]);
        });
    });

    describe('getQueueLength', () => {
        it('should return queue length', async () => {
            mockClient.llen.mockResolvedValue(42);

            const result = await queueManager.getQueueLength('test-queue');

            expect(result).toBe(42);
            expect(mockClient.llen).toHaveBeenCalledWith('queue:test-queue');
        });

        it('should return 0 when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await queueManager.getQueueLength('queue');

            expect(result).toBe(0);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.llen.mockRejectedValue(new Error('Llen failed'));

            const result = await queueManager.getQueueLength('queue');

            expect(result).toBe(0);
        });
    });

    describe('moveToDLQ', () => {
        it('should move message to dead letter queue', async () => {
            const message = { data: { type: 'test' }, attempts: 3 };
            const error = new Error('Processing failed');

            const result = await queueManager.moveToDLQ('test-queue', message, error);

            expect(result).toBe(true);
            expect(mockClient.rpush).toHaveBeenCalledWith(
                'dlq:test-queue',
                expect.stringContaining('"originalMessage":')
            );

            const dlqArg = JSON.parse(mockClient.rpush.mock.calls[0][1]);
            expect(dlqArg.originalMessage).toEqual(message);
            expect(dlqArg.error).toBe('Processing failed');
            expect(dlqArg.failedAt).toBeDefined();
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await queueManager.moveToDLQ('queue', {}, new Error('test'));

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.rpush.mockRejectedValue(new Error('DLQ push failed'));

            const result = await queueManager.moveToDLQ('queue', {}, new Error('test'));

            expect(result).toBe(false);
        });
    });

    describe('requeueWithRetry', () => {
        it('should requeue message with incremented attempts', async () => {
            const message = { data: 'test', timestamp: 123, attempts: 1 };

            const result = await queueManager.requeueWithRetry('queue', message);

            expect(result).toBe(true);
            expect(mockClient.lpush).toHaveBeenCalledWith(
                'queue:queue',
                expect.any(String)
            );

            const requeuedArg = JSON.parse(mockClient.lpush.mock.calls[0][1]);
            expect(requeuedArg.attempts).toBe(2);
        });

        it('should handle missing attempts property', async () => {
            const message = { data: 'test', timestamp: 123 };

            await queueManager.requeueWithRetry('queue', message);

            const requeuedArg = JSON.parse(mockClient.lpush.mock.calls[0][1]);
            expect(requeuedArg.attempts).toBe(1);
        });

        it('should return false when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            const result = await queueManager.requeueWithRetry('queue', {});

            expect(result).toBe(false);
        });

        it('should handle Redis errors gracefully', async () => {
            mockClient.lpush.mockRejectedValue(new Error('Requeue failed'));

            const result = await queueManager.requeueWithRetry('queue', {});

            expect(result).toBe(false);
        });
    });

    describe('startConsumer', () => {
        it('should start analytics consumer', async () => {
            await queueManager.startConsumer();

            expect(AnalyticsQueueConsumer).toHaveBeenCalledWith(queueManager, mockDbManager);
            expect(mockAnalyticsConsumer.start).toHaveBeenCalled();
            expect(queueManager.consumerRunning).toBe(true);
        });

        it('should not start if already running', async () => {
            queueManager.consumerRunning = true;

            await queueManager.startConsumer();

            expect(AnalyticsQueueConsumer).not.toHaveBeenCalled();
        });
    });

    describe('stopConsumer', () => {
        it('should stop analytics consumer', async () => {
            queueManager.consumerRunning = true;
            queueManager.analyticsConsumer = mockAnalyticsConsumer;

            await queueManager.stopConsumer();

            expect(mockAnalyticsConsumer.stop).toHaveBeenCalled();
            expect(queueManager.consumerRunning).toBe(false);
        });

        it('should do nothing if not running', async () => {
            queueManager.consumerRunning = false;

            await queueManager.stopConsumer();

            expect(mockAnalyticsConsumer.stop).not.toHaveBeenCalled();
        });
    });

    describe('drainQueues', () => {
        it('should resolve immediately when queues are empty', async () => {
            mockClient.llen.mockResolvedValue(0);

            const drainPromise = queueManager.drainQueues(5000);
            await jest.advanceTimersByTimeAsync(100);
            await drainPromise;

            expect(mockClient.llen).toHaveBeenCalled();
        });

        it('should wait for queues to empty', async () => {
            mockClient.llen
                .mockResolvedValueOnce(5)
                .mockResolvedValueOnce(3)
                .mockResolvedValueOnce(2)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0);

            const drainPromise = queueManager.drainQueues(10000);

            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);
            await drainPromise;

            expect(mockClient.llen).toHaveBeenCalled();
        });

        it('should timeout with warning if queues not drained', async () => {
            mockClient.llen.mockResolvedValue(10);

            const drainPromise = queueManager.drainQueues(1000);

            await jest.advanceTimersByTimeAsync(1500);
            await drainPromise;

            expect(mockClient.llen).toHaveBeenCalled();
        });

        it('should do nothing when Redis is unavailable', async () => {
            mockRedisManager.connected.mockReturnValue(false);

            await queueManager.drainQueues(1000);

            expect(mockClient.llen).not.toHaveBeenCalled();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle full message lifecycle', async () => {
            mockClient.lpop
                .mockResolvedValueOnce('{"data":{"type":"test"},"timestamp":123,"attempts":0}')
                .mockResolvedValueOnce(null);

            await queueManager.push('queue', { type: 'test' });
            expect(mockClient.rpush).toHaveBeenCalled();

            const messages = await queueManager.pop('queue');
            expect(messages).toHaveLength(1);
        });

        it('should handle consumer lifecycle', async () => {
            await queueManager.startConsumer();
            expect(queueManager.consumerRunning).toBe(true);

            await queueManager.stopConsumer();
            expect(queueManager.consumerRunning).toBe(false);
        });
    });
});
