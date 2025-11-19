// src/websocket/webSocketManager.js

const WebSocket = require('ws');
const config = require('../config/config');
const logger = require('../logger/logger');

class WebSocketManager {
    constructor(tokenManager, chatHandler, redemptionHandler, streamOnlineHandler, streamOfflineHandler, followHandler = null) {
        this.tokenManager = tokenManager;
        this.wsConnection = null;
        this.sessionId = null;
        this.chatHandler = chatHandler;
        this.redemptionHandler = redemptionHandler;
        this.streamOnlineHandler = streamOnlineHandler;
        this.streamOfflineHandler = streamOfflineHandler;
        this.followHandler = followHandler;
        this.onSessionReady = null;

        logger.debug('WebSocketManager', 'WebSocketManager instance created');
    }

    async connect() {
        try {
            logger.info('WebSocketManager', 'Connecting to WebSocket', { endpoint: config.wsEndpoint });
            this.wsConnection = new WebSocket(config.wsEndpoint);

            this.wsConnection.on('close', (code, reason) => {
                logger.warn('WebSocketManager', 'WebSocket connection closed', { code, reason: reason.toString() });
                logger.info('WebSocketManager', `Reconnecting in ${config.wsReconnectDelay}ms`);
                setTimeout(() => this.connect(), config.wsReconnectDelay);
            });

            this.wsConnection.on('message', async (data) => {
                try {
                    const message = JSON.parse(data);
                    await this.handleMessage(message);
                } catch (parseError) {
                    logger.error('WebSocketManager', 'Failed to parse WebSocket message', { error: parseError.message });
                }
            });

            this.wsConnection.on('error', (error) => {
                logger.error('WebSocketManager', 'WebSocket connection error', { error: error.message });
            });

            logger.debug('WebSocketManager', 'WebSocket event handlers registered');

        } catch (error) {
            logger.error('WebSocketManager', 'Failed to connect to WebSocket', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async handleMessage(message) {
        try {
            if (!message.metadata) {
                logger.error('WebSocketManager', 'Received message without metadata', { message: JSON.stringify(message) });
                return;
            }

            const messageType = message.metadata.message_type;
            logger.debug('WebSocketManager', 'Received WebSocket message', { type: messageType });

            switch (messageType) {
            case 'session_welcome': {
                this.sessionId = message.payload.session.id;
                logger.info('WebSocketManager', 'WebSocket session established', { sessionId: this.sessionId });

                if (this.onSessionReady) {
                    logger.debug('WebSocketManager', 'Triggering session ready callback');
                    await this.onSessionReady(this.sessionId);
                }
                break;
            }
            case 'notification': {
                const subscriptionType = message.metadata.subscription_type;
                logger.debug('WebSocketManager', 'Received notification', { subscriptionType });

                if (subscriptionType === 'channel.chat.message') {
                    if (this.chatHandler) {
                        await this.chatHandler(message.payload);
                    } else {
                        logger.debug('WebSocketManager', 'Received chat message but no handler registered');
                    }
                } else if (subscriptionType === 'channel.channel_points_custom_reward_redemption.add') {
                    if (this.redemptionHandler) {
                        await this.redemptionHandler(message.payload);
                    } else {
                        logger.debug('WebSocketManager', 'Received redemption but no handler registered');
                    }
                } else if (subscriptionType === 'stream.online') {
                    logger.info('WebSocketManager', 'Received stream online event');
                    if (this.streamOnlineHandler) {
                        await this.streamOnlineHandler();
                    }
                } else if (subscriptionType === 'stream.offline') {
                    logger.info('WebSocketManager', 'Received stream offline event');
                    if (this.streamOfflineHandler) {
                        await this.streamOfflineHandler();
                    }
                } else if (subscriptionType === 'channel.follow') {
                    logger.info('WebSocketManager', 'Received channel follow event', {
                        userId: message.payload.event?.user_id,
                        userName: message.payload.event?.user_name
                    });
                    if (this.followHandler) {
                        await this.followHandler(message.payload.event);
                    } else {
                        logger.debug('WebSocketManager', 'Received follow event but no handler registered');
                    }
                } else {
                    logger.debug('WebSocketManager', 'Received unknown subscription type', { subscriptionType });
                }
                break;
            }
            case 'session_reconnect': {
                logger.info('WebSocketManager', 'Server requested reconnection');
                await this.connect();
                break;
            }
            case 'session_keepalive': {
                logger.debug('WebSocketManager', 'Received keepalive');
                break;
            }
            default: {
                logger.warn('WebSocketManager', 'Received unknown message type', { messageType });
            }
            }
        } catch (error) {
            logger.error('WebSocketManager', 'Error handling WebSocket message', { error: error.message, stack: error.stack });
        }
    }

    close() {
        if (this.wsConnection) {
            logger.info('WebSocketManager', 'Closing WebSocket connection');
            this.wsConnection.close();
        }
    }
}

module.exports = WebSocketManager;
