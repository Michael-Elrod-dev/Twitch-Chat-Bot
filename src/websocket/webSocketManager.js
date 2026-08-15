const WebSocket = require('ws');
const config = require('../config/config');
const logger = require('../logger/logger');

// Why a socket closed, which decides whether we reconnect.
// Twitch documents EventSub delivery as at-least-once and instructs clients to
// dedup on metadata.message_id:
// https://dev.twitch.tv/docs/eventsub/handling-webhook-events/#handling-duplicate-events
// Bounded so a long-running session cannot grow this without limit.
const MAX_SEEN_MESSAGE_IDS = 1000;

const CLOSE_INTENT = {
    UNEXPECTED: 'unexpected',   // dropped on us - reconnect
    INTENTIONAL: 'intentional', // we are shutting down - stay closed
    REPLACED: 'replaced'        // superseded by a reconnect_url socket - stay closed
};

class WebSocketManager {
    constructor({
        tokenManager,
        onChatMessage = null,
        onRedemption = null,
        onStreamOnline = null,
        onStreamOffline = null,
        onFollow = null
    } = {}) {
        this.tokenManager = tokenManager;
        this.onChatMessage = onChatMessage;
        this.onRedemption = onRedemption;
        this.onStreamOnline = onStreamOnline;
        this.onStreamOffline = onStreamOffline;
        this.onFollow = onFollow;

        // Set by the owner: onSessionReady fires for a brand-new session that needs
        // subscriptions created; onSessionMoved fires when Twitch hands us a
        // reconnect_url session, which already carries the old subscriptions over.
        this.onSessionReady = null;
        this.onSessionMoved = null;

        this.wsConnection = null;
        this.pendingConnection = null;
        this.sessionId = null;
        this.reconnectTimer = null;
        this.isClosing = false;
        this.closeIntents = new WeakMap();

        // Insertion-ordered, so the oldest id is always the first key.
        this.seenMessageIds = new Set();

        logger.debug('WebSocketManager', 'WebSocketManager instance created');
    }

    async connect(endpoint = config.wsEndpoint) {
        try {
            logger.info('WebSocketManager', 'Connecting to WebSocket', { endpoint });

            this.clearReconnectTimer();
            this.isClosing = false;

            const socket = new WebSocket(endpoint);
            this.attachHandlers(socket);
            this.wsConnection = socket;

            logger.debug('WebSocketManager', 'WebSocket event handlers registered');

        } catch (error) {
            logger.error('WebSocketManager', 'Failed to connect to WebSocket', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Twitch asked us to move. Per the EventSub protocol the new session inherits
     * the old session's subscriptions, so we do NOT resubscribe here - we just keep
     * the old socket alive until the new one welcomes us, then swap.
     */
    async reconnectTo(reconnectUrl) {
        try {
            logger.info('WebSocketManager', 'Opening replacement connection', { reconnectUrl });

            if (this.pendingConnection) {
                logger.warn('WebSocketManager', 'Replacement connection already in progress, ignoring');
                return;
            }

            const socket = new WebSocket(reconnectUrl);
            this.attachHandlers(socket);
            this.pendingConnection = socket;

        } catch (error) {
            logger.error('WebSocketManager', 'Failed to open replacement connection', { error: error.message, stack: error.stack });
        }
    }

    attachHandlers(socket) {
        socket.on('close', (code, reason) => this.handleClose(socket, code, reason));

        socket.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                await this.handleMessage(message, socket);
            } catch (parseError) {
                logger.error('WebSocketManager', 'Failed to parse WebSocket message', { error: parseError.message });
            }
        });

        socket.on('error', (error) => {
            logger.error('WebSocketManager', 'WebSocket connection error', { error: error.message });
        });
    }

    handleClose(socket, code, reason) {
        const intent = this.closeIntents.get(socket) || CLOSE_INTENT.UNEXPECTED;
        this.closeIntents.delete(socket);

        logger.warn('WebSocketManager', 'WebSocket connection closed', {
            code,
            reason: reason ? reason.toString() : undefined,
            intent
        });

        if (intent !== CLOSE_INTENT.UNEXPECTED) {
            logger.debug('WebSocketManager', 'Close was expected, not reconnecting', { intent });
            return;
        }

        if (this.isClosing) {
            logger.debug('WebSocketManager', 'Shutting down, not reconnecting');
            return;
        }

        if (socket === this.pendingConnection) {
            logger.warn('WebSocketManager', 'Replacement connection died before welcome, keeping current connection');
            this.pendingConnection = null;
            return;
        }

        if (socket !== this.wsConnection) {
            logger.debug('WebSocketManager', 'Stale socket closed, nothing to do');
            return;
        }

        logger.info('WebSocketManager', `Reconnecting in ${config.wsReconnectDelay}ms`);
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((error) => {
                logger.error('WebSocketManager', 'Reconnect attempt failed', { error: error.message });
            });
        }, config.wsReconnectDelay);
    }

    async handleMessage(message, socket = this.wsConnection) {
        try {
            if (!message.metadata) {
                logger.error('WebSocketManager', 'Received message without metadata', { message: JSON.stringify(message) });
                return;
            }

            const messageType = message.metadata.message_type;
            logger.debug('WebSocketManager', 'Received WebSocket message', { type: messageType });

            if (this.isDuplicate(message.metadata.message_id)) {
                logger.warn('WebSocketManager', 'Dropping duplicate EventSub message', {
                    messageId: message.metadata.message_id,
                    type: messageType
                });
                return;
            }

            switch (messageType) {
            case 'session_welcome': {
                await this.handleSessionWelcome(message, socket);
                break;
            }
            case 'notification': {
                const subscriptionType = message.metadata.subscription_type;
                logger.debug('WebSocketManager', 'Received notification', { subscriptionType });

                if (subscriptionType === 'channel.chat.message') {
                    if (this.onChatMessage) {
                        await this.onChatMessage(message.payload);
                    } else {
                        logger.debug('WebSocketManager', 'Received chat message but no handler registered');
                    }
                } else if (subscriptionType === 'channel.channel_points_custom_reward_redemption.add') {
                    if (this.onRedemption) {
                        await this.onRedemption(message.payload);
                    } else {
                        logger.debug('WebSocketManager', 'Received redemption but no handler registered');
                    }
                } else if (subscriptionType === 'stream.online') {
                    logger.info('WebSocketManager', 'Received stream online event');
                    if (this.onStreamOnline) {
                        await this.onStreamOnline();
                    }
                } else if (subscriptionType === 'stream.offline') {
                    logger.info('WebSocketManager', 'Received stream offline event');
                    if (this.onStreamOffline) {
                        await this.onStreamOffline();
                    }
                } else if (subscriptionType === 'channel.follow') {
                    logger.info('WebSocketManager', 'Received channel follow event', {
                        userId: message.payload.event?.user_id,
                        userName: message.payload.event?.user_name
                    });
                    if (this.onFollow) {
                        await this.onFollow(message.payload.event);
                    } else {
                        logger.debug('WebSocketManager', 'Received follow event but no handler registered');
                    }
                } else {
                    logger.debug('WebSocketManager', 'Received unknown subscription type', { subscriptionType });
                }
                break;
            }
            case 'session_reconnect': {
                const reconnectUrl = message.payload?.session?.reconnect_url;
                logger.info('WebSocketManager', 'Server requested reconnection', { reconnectUrl });

                if (!reconnectUrl) {
                    logger.error('WebSocketManager', 'session_reconnect had no reconnect_url, ignoring');
                    break;
                }

                await this.reconnectTo(reconnectUrl);
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

    async handleSessionWelcome(message, socket) {
        const sessionId = message.payload.session.id;
        const isReplacement = socket === this.pendingConnection && this.pendingConnection !== null;

        // We have a live session, so any reconnect still queued is obsolete. This
        // matters most on the promotion path: if the old socket died mid-migration
        // (Twitch closes it with 4004 after 30s) its close armed a reconnect, and
        // letting that fire would overwrite the healthy socket we just promoted and
        // resubscribe on a second live session.
        this.clearReconnectTimer();

        this.sessionId = sessionId;

        if (isReplacement) {
            logger.info('WebSocketManager', 'Replacement session established, retiring old connection', { sessionId });

            const oldSocket = this.wsConnection;
            this.wsConnection = socket;
            this.pendingConnection = null;

            if (oldSocket && oldSocket !== socket) {
                this.closeIntents.set(oldSocket, CLOSE_INTENT.REPLACED);
                try {
                    oldSocket.close();
                } catch (error) {
                    logger.error('WebSocketManager', 'Error closing replaced connection', { error: error.message });
                }
            }

            // Subscriptions transfer with the session - only the id needs updating.
            if (this.onSessionMoved) {
                await this.onSessionMoved(sessionId);
            }
            return;
        }

        logger.info('WebSocketManager', 'WebSocket session established', { sessionId });

        if (this.onSessionReady) {
            logger.debug('WebSocketManager', 'Triggering session ready callback');
            await this.onSessionReady(sessionId);
        }
    }

    /**
     * Records a message id and reports whether it had already been seen. Applied at
     * the metadata level so it covers every notification type, not just redemptions.
     */
    isDuplicate(messageId) {
        if (!messageId) {
            return false;
        }

        if (this.seenMessageIds.has(messageId)) {
            return true;
        }

        this.seenMessageIds.add(messageId);

        if (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
            const oldest = this.seenMessageIds.values().next().value;
            this.seenMessageIds.delete(oldest);
        }

        return false;
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    close() {
        logger.info('WebSocketManager', 'Closing WebSocket connection');

        this.isClosing = true;
        this.clearReconnectTimer();

        for (const socket of [this.pendingConnection, this.wsConnection]) {
            if (!socket) continue;
            this.closeIntents.set(socket, CLOSE_INTENT.INTENTIONAL);
            try {
                socket.close();
            } catch (error) {
                logger.error('WebSocketManager', 'Error closing WebSocket', { error: error.message });
            }
        }

        this.pendingConnection = null;
    }
}

module.exports = WebSocketManager;
module.exports.CLOSE_INTENT = CLOSE_INTENT;
