// tests/redis/analyticsQueueConsumer.test.js

const AnalyticsQueueConsumer = require('../../src/redis/analyticsQueueConsumer');

jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    analyticsQueue: {
        batchSize: 50,
        batchIntervalMs: 5000,
        maxRetries: 3
    }
}));

const logger = require('../../src/logger/logger');

describe('AnalyticsQueueConsumer', () => {
    let consumer;
    let mockQueueManager;
    let mockDbManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockQueueManager = {
            pop: jest.fn().mockResolvedValue([]),
            moveToDLQ: jest.fn().mockResolvedValue(true),
            requeueWithRetry: jest.fn().mockResolvedValue(true)
        };

        mockDbManager = {
            query: jest.fn().mockResolvedValue({ affectedRows: 1 })
        };

        consumer = new AnalyticsQueueConsumer(mockQueueManager, mockDbManager);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with correct properties', () => {
            expect(consumer.queueManager).toBe(mockQueueManager);
            expect(consumer.dbManager).toBe(mockDbManager);
            expect(consumer.running).toBe(false);
            expect(consumer.processInterval).toBeNull();
            expect(consumer.batchSize).toBe(50);
            expect(consumer.intervalMs).toBe(5000);
            expect(consumer.maxRetries).toBe(3);
        });
    });

    describe('start', () => {
        it('should start processing interval', async () => {
            await consumer.start();

            expect(consumer.running).toBe(true);
            expect(consumer.processInterval).not.toBeNull();
            expect(logger.info).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Starting analytics queue consumer',
                expect.objectContaining({
                    batchSize: 50,
                    intervalMs: 5000
                })
            );
        });

        it('should process batches immediately on start', async () => {
            mockQueueManager.pop.mockResolvedValue([]);

            await consumer.start();

            expect(mockQueueManager.pop).toHaveBeenCalledWith('analytics:chat_messages', 50);
            expect(mockQueueManager.pop).toHaveBeenCalledWith('analytics:chat_totals', 50);
        });

        it('should not start if already running', async () => {
            consumer.running = true;

            await consumer.start();

            expect(logger.info).not.toHaveBeenCalled();
        });

        it('should process batches on interval', async () => {
            await consumer.start();
            jest.clearAllMocks();

            // Advance timer
            await jest.advanceTimersByTimeAsync(5000);

            expect(mockQueueManager.pop).toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('should stop processing and clear interval', async () => {
            await consumer.start();

            await consumer.stop();

            expect(consumer.running).toBe(false);
            expect(consumer.processInterval).toBeNull();
            expect(logger.info).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Analytics queue consumer stopped'
            );
        });

        it('should process remaining batches before stopping', async () => {
            await consumer.start();
            jest.clearAllMocks();

            await consumer.stop();

            // Should have processed batches one final time
            expect(mockQueueManager.pop).toHaveBeenCalled();
        });
    });

    describe('processBatches', () => {
        it('should process both chat messages and totals', async () => {
            await consumer.processBatches();

            expect(mockQueueManager.pop).toHaveBeenCalledWith('analytics:chat_messages', 50);
            expect(mockQueueManager.pop).toHaveBeenCalledWith('analytics:chat_totals', 50);
        });

        it('should handle errors gracefully', async () => {
            mockQueueManager.pop.mockRejectedValue(new Error('Pop failed'));

            await consumer.processBatches();

            expect(logger.error).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Error processing batches',
                expect.objectContaining({
                    error: 'Pop failed'
                })
            );
        });
    });

    describe('processChatMessages', () => {
        it('should insert messages to database', async () => {
            const messages = [
                {
                    data: {
                        userId: 'user1',
                        streamId: 'stream1',
                        messageTime: new Date('2024-01-01'),
                        messageType: 'message',
                        content: 'Hello'
                    },
                    timestamp: Date.now(),
                    attempts: 0
                }
            ];
            mockQueueManager.pop
                .mockResolvedValueOnce(messages)
                .mockResolvedValue([]);

            await consumer.processChatMessages();

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO chat_messages'),
                expect.arrayContaining(['user1', 'stream1', 'message', 'Hello'])
            );
        });

        it('should handle empty queue gracefully', async () => {
            mockQueueManager.pop.mockResolvedValue([]);

            await consumer.processChatMessages();

            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should retry failed messages under max retries', async () => {
            const messages = [
                {
                    data: { userId: 'user1', streamId: 's1', messageType: 'message', content: 'test' },
                    timestamp: Date.now(),
                    attempts: 1
                }
            ];
            mockQueueManager.pop.mockResolvedValueOnce(messages).mockResolvedValue([]);
            mockDbManager.query.mockRejectedValueOnce(new Error('Insert failed'));

            await consumer.processChatMessages();

            expect(mockQueueManager.requeueWithRetry).toHaveBeenCalledWith(
                'analytics:chat_messages',
                expect.objectContaining({ attempts: 1 })
            );
        });

        it('should move to DLQ after max retries', async () => {
            const messages = [
                {
                    data: { userId: 'user1', streamId: 's1', messageType: 'message', content: 'test' },
                    timestamp: Date.now(),
                    attempts: 3
                }
            ];
            mockQueueManager.pop.mockResolvedValueOnce(messages).mockResolvedValue([]);
            mockDbManager.query.mockRejectedValueOnce(new Error('Insert failed'));

            await consumer.processChatMessages();

            expect(mockQueueManager.moveToDLQ).toHaveBeenCalledWith(
                'analytics:chat_messages',
                expect.objectContaining({ attempts: 3 }),
                expect.any(Error)
            );
            expect(mockQueueManager.requeueWithRetry).not.toHaveBeenCalled();
        });

        it('should log batch processing stats', async () => {
            const messages = [
                {
                    data: { userId: 'user1', streamId: 's1', messageType: 'message', content: 'test' },
                    timestamp: Date.now(),
                    attempts: 0
                }
            ];
            mockQueueManager.pop.mockResolvedValueOnce(messages).mockResolvedValue([]);

            await consumer.processChatMessages();

            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Processing chat messages batch',
                { count: 1 }
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Chat messages batch processed',
                expect.objectContaining({
                    successful: 1,
                    retried: 0,
                    dlq: 0
                })
            );
        });

        it('should use current date when messageTime is missing', async () => {
            const messages = [
                {
                    data: { userId: 'user1', streamId: 's1', messageType: 'message', content: 'test' },
                    timestamp: Date.now(),
                    attempts: 0
                }
            ];
            mockQueueManager.pop.mockResolvedValueOnce(messages).mockResolvedValue([]);

            await consumer.processChatMessages();

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Date)])
            );
        });
    });

    describe('processChatTotals', () => {
        it('should aggregate and update totals by user', async () => {
            const messages = [
                { data: { userId: 'user1', messageType: 'message' }, attempts: 0 },
                { data: { userId: 'user1', messageType: 'message' }, attempts: 0 },
                { data: { userId: 'user1', messageType: 'command' }, attempts: 0 },
                { data: { userId: 'user2', messageType: 'redemption' }, attempts: 0 }
            ];
            mockQueueManager.pop
                .mockResolvedValueOnce([]) // chat_messages
                .mockResolvedValueOnce(messages);

            await consumer.processBatches();

            // Should have 2 calls - one for user1 and one for user2
            expect(mockDbManager.query).toHaveBeenCalledTimes(2);

            // Check user1 aggregation (2 messages + 1 command)
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO chat_totals'),
                expect.arrayContaining(['user1', 2, 1, 0, 3])
            );

            // Check user2 aggregation (1 redemption)
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO chat_totals'),
                expect.arrayContaining(['user2', 0, 0, 1, 1])
            );
        });

        it('should handle empty queue gracefully', async () => {
            mockQueueManager.pop.mockResolvedValue([]);

            await consumer.processChatTotals();

            expect(mockDbManager.query).not.toHaveBeenCalled();
        });

        it('should handle database errors and requeue affected messages', async () => {
            const messages = [
                { data: { userId: 'user1', messageType: 'message' }, attempts: 0 }
            ];
            mockQueueManager.pop
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(messages);
            mockDbManager.query.mockRejectedValueOnce(new Error('Update failed'));

            await consumer.processBatches();

            expect(mockQueueManager.requeueWithRetry).toHaveBeenCalledWith(
                'analytics:chat_totals',
                expect.objectContaining({ data: { userId: 'user1', messageType: 'message' } })
            );
        });

        it('should move to DLQ after max retries on totals update failure', async () => {
            const messages = [
                { data: { userId: 'user1', messageType: 'message' }, attempts: 3 }
            ];
            mockQueueManager.pop
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(messages);
            mockDbManager.query.mockRejectedValueOnce(new Error('Update failed'));

            await consumer.processBatches();

            expect(mockQueueManager.moveToDLQ).toHaveBeenCalled();
        });

        it('should log batch processing stats', async () => {
            const messages = [
                { data: { userId: 'user1', messageType: 'message' }, attempts: 0 }
            ];
            mockQueueManager.pop
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce(messages);

            await consumer.processBatches();

            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Processing chat totals batch',
                { count: 1 }
            );
            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Chat totals batch processed',
                { usersUpdated: 1 }
            );
        });
    });

    describe('Integration scenarios', () => {
        it('should handle mixed success and failure in batch', async () => {
            const messages = [
                { data: { userId: 'u1', streamId: 's1', messageType: 'message', content: 'ok' }, attempts: 0 },
                { data: { userId: 'u2', streamId: 's1', messageType: 'message', content: 'fail' }, attempts: 2 },
                { data: { userId: 'u3', streamId: 's1', messageType: 'message', content: 'ok2' }, attempts: 0 }
            ];
            mockQueueManager.pop.mockResolvedValueOnce(messages).mockResolvedValue([]);

            // First and third succeed, second fails
            mockDbManager.query
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error('DB error'))
                .mockResolvedValueOnce({});

            await consumer.processChatMessages();

            expect(logger.debug).toHaveBeenCalledWith(
                'AnalyticsQueueConsumer',
                'Chat messages batch processed',
                expect.objectContaining({
                    successful: 2,
                    retried: 1,
                    dlq: 0
                })
            );
        });

        it('should continue running after errors', async () => {
            await consumer.start();

            // Simulate error
            mockQueueManager.pop.mockRejectedValueOnce(new Error('Temporary error'));
            await jest.advanceTimersByTimeAsync(5000);

            // Should still be running
            expect(consumer.running).toBe(true);

            // Next interval should work
            mockQueueManager.pop.mockResolvedValue([]);
            await jest.advanceTimersByTimeAsync(5000);

            expect(mockQueueManager.pop).toHaveBeenCalled();
        });

        it('should handle complete consumer lifecycle', async () => {
            // Start
            await consumer.start();
            expect(consumer.running).toBe(true);

            // Run some batches
            await jest.advanceTimersByTimeAsync(10000);

            // Stop
            await consumer.stop();
            expect(consumer.running).toBe(false);

            // Verify final batch was processed
            expect(mockQueueManager.pop).toHaveBeenCalled();
        });
    });
});
