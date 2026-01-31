// src/redis/analyticsQueueConsumer.js

const config = require('../config/config');
const logger = require('../logger/logger');

class AnalyticsQueueConsumer {
    constructor(queueManager, dbManager) {
        this.queueManager = queueManager;
        this.dbManager = dbManager;
        this.running = false;
        this.processInterval = null;
        this.batchSize = config.analyticsQueue.batchSize;
        this.intervalMs = config.analyticsQueue.batchIntervalMs;
        this.maxRetries = config.analyticsQueue.maxRetries;
    }

    async start() {
        if (this.running) {
            return;
        }

        this.running = true;
        logger.info('AnalyticsQueueConsumer', 'Starting analytics queue consumer', {
            batchSize: this.batchSize,
            intervalMs: this.intervalMs
        });

        this.processInterval = setInterval(async () => {
            if (!this.running) return;
            await this.processBatches();
        }, this.intervalMs);

        await this.processBatches();
    }

    async stop() {
        this.running = false;

        if (this.processInterval) {
            clearInterval(this.processInterval);
            this.processInterval = null;
        }

        await this.processBatches();

        logger.info('AnalyticsQueueConsumer', 'Analytics queue consumer stopped');
    }

    async processBatches() {
        try {
            await this.processChatMessages();
            await this.processChatTotals();
        } catch (error) {
            logger.error('AnalyticsQueueConsumer', 'Error processing batches', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async processChatMessages() {
        const queueName = 'analytics:chat_messages';
        const messages = await this.queueManager.pop(queueName, this.batchSize);

        if (messages.length === 0) {
            return;
        }

        logger.debug('AnalyticsQueueConsumer', 'Processing chat messages batch', {
            count: messages.length
        });

        const toRetry = [];
        const toDLQ = [];
        const successful = [];

        for (const message of messages) {
            try {
                await this.insertChatMessage(message.data);
                successful.push(message);
            } catch (error) {
                logger.error('AnalyticsQueueConsumer', 'Error processing chat message', {
                    error: error.message,
                    attempts: message.attempts
                });

                if (message.attempts >= this.maxRetries) {
                    toDLQ.push({ message, error });
                } else {
                    toRetry.push(message);
                }
            }
        }

        for (const message of toRetry) {
            await this.queueManager.requeueWithRetry(queueName, message);
        }

        for (const { message, error } of toDLQ) {
            await this.queueManager.moveToDLQ(queueName, message, error);
        }

        if (successful.length > 0) {
            logger.debug('AnalyticsQueueConsumer', 'Chat messages batch processed', {
                successful: successful.length,
                retried: toRetry.length,
                dlq: toDLQ.length
            });
        }
    }

    async insertChatMessage(data) {
        const sql = `
            INSERT INTO chat_messages (user_id, stream_id, message_time, message_type, message_content)
            VALUES (?, ?, ?, ?, ?)
        `;
        await this.dbManager.query(sql, [
            data.userId,
            data.streamId,
            data.messageTime || new Date(),
            data.messageType,
            data.content
        ]);
    }

    async processChatTotals() {
        const queueName = 'analytics:chat_totals';
        const messages = await this.queueManager.pop(queueName, this.batchSize);

        if (messages.length === 0) {
            return;
        }

        logger.debug('AnalyticsQueueConsumer', 'Processing chat totals batch', {
            count: messages.length
        });

        const aggregated = new Map();

        for (const message of messages) {
            const key = message.data.userId;
            if (!aggregated.has(key)) {
                aggregated.set(key, {
                    userId: message.data.userId,
                    message_count: 0,
                    command_count: 0,
                    redemption_count: 0,
                    total_count: 0
                });
            }

            const entry = aggregated.get(key);
            const type = message.data.messageType;

            if (type === 'message') {
                entry.message_count++;
            } else if (type === 'command') {
                entry.command_count++;
            } else if (type === 'redemption') {
                entry.redemption_count++;
            }
            entry.total_count++;
        }

        for (const [userId, counts] of aggregated) {
            try {
                await this.updateChatTotals(userId, counts);
            } catch (error) {
                logger.error('AnalyticsQueueConsumer', 'Error updating chat totals', {
                    userId,
                    error: error.message
                });

                for (const message of messages.filter(m => m.data.userId === userId)) {
                    if (message.attempts >= this.maxRetries) {
                        await this.queueManager.moveToDLQ('analytics:chat_totals', message, error);
                    } else {
                        await this.queueManager.requeueWithRetry('analytics:chat_totals', message);
                    }
                }
            }
        }

        logger.debug('AnalyticsQueueConsumer', 'Chat totals batch processed', {
            usersUpdated: aggregated.size
        });
    }

    async updateChatTotals(userId, counts) {
        const sql = `
            INSERT INTO chat_totals (user_id, message_count, command_count, redemption_count, total_count)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                message_count = message_count + VALUES(message_count),
                command_count = command_count + VALUES(command_count),
                redemption_count = redemption_count + VALUES(redemption_count),
                total_count = total_count + VALUES(total_count)
        `;
        await this.dbManager.query(sql, [
            userId,
            counts.message_count,
            counts.command_count,
            counts.redemption_count,
            counts.total_count
        ]);
    }
}

module.exports = AnalyticsQueueConsumer;
