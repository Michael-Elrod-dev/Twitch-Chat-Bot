const config = require('../config/config');
const logger = require('../logger/logger');

class QueueManager {
    constructor(redisManager, dbManager) {
        this.redisManager = redisManager;
        this.dbManager = dbManager;
        this.consumerRunning = false;
        this.analyticsConsumer = null;
    }

    isAvailable() {
        return this.redisManager && this.redisManager.connected();
    }

    getClient() {
        if (!this.isAvailable()) {
            return null;
        }
        return this.redisManager.getClient();
    }

    async push(queueName, message) {
        const client = this.getClient();
        if (!client) {
            logger.debug('QueueManager', 'Redis unavailable, message not queued', { queueName });
            return false;
        }

        try {
            const serialized = JSON.stringify({
                data: message,
                timestamp: Date.now(),
                attempts: 0
            });

            await client.rpush(`queue:${queueName}`, serialized);
            logger.debug('QueueManager', 'Message pushed to queue', {
                queueName,
                messageType: message.type || 'unknown'
            });
            return true;
        } catch (error) {
            logger.error('QueueManager', 'Error pushing to queue', {
                queueName,
                error: error.message
            });
            return false;
        }
    }

    async pop(queueName, count = 1) {
        const client = this.getClient();
        if (!client) {
            return [];
        }

        try {
            const items = await this.lpopMany(client, `queue:${queueName}`, count);

            const messages = [];
            for (const item of items) {
                try {
                    messages.push(JSON.parse(item));
                } catch (parseError) {
                    logger.error('QueueManager', 'Error parsing queue message', {
                        queueName,
                        error: parseError.message
                    });
                }
            }
            return messages;
        } catch (error) {
            logger.error('QueueManager', 'Error popping from queue', {
                queueName,
                error: error.message
            });
            return [];
        }
    }

    /**
     * One round-trip via LPOP key count (Redis 6.2+), falling back to a loop of
     * single LPOPs on older servers. Previously a 50-message batch cost 50 round
     * trips every 5 seconds.
     */
    async lpopMany(client, key, count) {
        if (count === 1) {
            const item = await client.lpop(key);
            return item ? [item] : [];
        }

        if (this.supportsCountedLpop !== false) {
            try {
                const items = await client.lpop(key, count);
                this.supportsCountedLpop = true;
                return items || [];
            } catch (error) {
                this.supportsCountedLpop = false;
                logger.warn('QueueManager', 'Counted LPOP unavailable, falling back to single pops', {
                    error: error.message
                });
            }
        }

        const items = [];
        for (let i = 0; i < count; i++) {
            const item = await client.lpop(key);
            if (!item) break;
            items.push(item);
        }
        return items;
    }

    async getQueueLength(queueName) {
        const client = this.getClient();
        if (!client) {
            return 0;
        }

        try {
            return await client.llen(`queue:${queueName}`);
        } catch (error) {
            logger.error('QueueManager', 'Error getting queue length', {
                queueName,
                error: error.message
            });
            // null means UNKNOWN. Returning 0 here made a failing Redis look
            // identical to a fully drained queue.
            return null;
        }
    }

    /**
     * @returns {Promise<{total: number, unknown: boolean, lengths: Array}>}
     */
    async measureQueues(queueNames) {
        const lengths = await Promise.all(queueNames.map(q => this.getQueueLength(q)));
        const unknown = lengths.some(length => length === null);
        const total = lengths.reduce((sum, length) => sum + (length || 0), 0);

        return { total, unknown, lengths };
    }

    async moveToDLQ(queueName, message, error) {
        const client = this.getClient();
        if (!client) {
            logger.error('QueueManager', 'Cannot move to DLQ - Redis unavailable', {
                queueName,
                error: error.message
            });
            return false;
        }

        try {
            const dlqMessage = JSON.stringify({
                originalMessage: message,
                error: error.message,
                failedAt: Date.now()
            });

            await client.rpush(`dlq:${queueName}`, dlqMessage);
            logger.warn('QueueManager', 'Message moved to dead letter queue', {
                queueName,
                messageType: message.data?.type || 'unknown'
            });
            return true;
        } catch (dlqError) {
            logger.error('QueueManager', 'Error moving message to DLQ', {
                queueName,
                error: dlqError.message
            });
            return false;
        }
    }

    async requeueWithRetry(queueName, message) {
        const client = this.getClient();
        if (!client) {
            return false;
        }

        try {
            message.attempts = (message.attempts || 0) + 1;
            const serialized = JSON.stringify(message);
            await client.lpush(`queue:${queueName}`, serialized);
            return true;
        } catch (error) {
            logger.error('QueueManager', 'Error requeuing message', {
                queueName,
                error: error.message
            });
            return false;
        }
    }

    async startConsumer() {
        if (this.consumerRunning) {
            logger.debug('QueueManager', 'Consumer already running');
            return;
        }

        const AnalyticsQueueConsumer = require('./analyticsQueueConsumer');
        this.analyticsConsumer = new AnalyticsQueueConsumer(this, this.dbManager);
        await this.analyticsConsumer.start();
        this.consumerRunning = true;

        logger.info('QueueManager', 'Queue consumer started');
    }

    async stopConsumer() {
        if (!this.consumerRunning) {
            return;
        }

        if (this.analyticsConsumer) {
            await this.analyticsConsumer.stop();
        }

        this.consumerRunning = false;
        logger.info('QueueManager', 'Queue consumer stopped');
    }

    async drainQueues(timeoutMs = config.analyticsQueue.drainTimeoutMs) {
        logger.info('QueueManager', 'Draining queues before shutdown', { timeoutMs });

        if (!this.isAvailable()) {
            logger.debug('QueueManager', 'Redis unavailable, nothing to drain');
            return { drained: true, timedOut: false, remaining: 0, unknown: false };
        }

        const startTime = Date.now();
        const checkInterval = 500;

        const queuesToDrain = ['analytics:chat_messages', 'analytics:chat_totals'];

        return new Promise((resolve) => {
            const checkQueues = async () => {
                const elapsed = Date.now() - startTime;
                const { total, unknown, lengths } = await this.measureQueues(queuesToDrain);

                if (elapsed >= timeoutMs) {
                    logger.warn('QueueManager', 'Drain timeout reached', {
                        remainingMessages: total,
                        lengthsUnknown: unknown,
                        elapsedMs: elapsed,
                        queueLengths: Object.fromEntries(
                            queuesToDrain.map((q, i) => [q, lengths[i]])
                        )
                    });
                    resolve({ drained: false, timedOut: true, remaining: total, unknown });
                    return;
                }

                // An unreadable length is not a drained queue - keep trying.
                if (!unknown && total === 0) {
                    logger.info('QueueManager', 'All queues drained successfully', {
                        elapsedMs: elapsed
                    });
                    resolve({ drained: true, timedOut: false, remaining: 0, unknown: false });
                    return;
                }

                logger.debug('QueueManager', 'Waiting for queues to drain', {
                    remainingMessages: total,
                    lengthsUnknown: unknown,
                    elapsedMs: elapsed
                });

                setTimeout(checkQueues, checkInterval);
            };

            checkQueues();
        });
    }
}

module.exports = QueueManager;
