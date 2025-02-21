// src/websocket/webSocketManager.js
const WebSocket = require('ws');
const config = require('../config/config');

class WebSocketManager {
    constructor(tokenManager, chatHandler, redemptionHandler, streamOfflineHandler) {
        this.tokenManager = tokenManager;
        this.wsConnection = null;
        this.sessionId = null;
        this.chatHandler = chatHandler;
        this.redemptionHandler = redemptionHandler;
        this.streamOfflineHandler = streamOfflineHandler;
        this.onSessionReady = null;
    }

    async connect() {
        try {
            this.wsConnection = new WebSocket(config.wsEndpoint);

            this.wsConnection.on('close', (code, reason) => {
                console.log(`* WebSocket closed: ${code} - ${reason}`);
                setTimeout(() => this.connect(), config.wsReconnectDelay);
            });

            this.wsConnection.on('message', async (data) => {
                const message = JSON.parse(data);
                await this.handleMessage(message);
            });

            this.wsConnection.on('error', (error) => {
                console.error('WebSocket error:', error);
            });

        } catch (error) {
            console.error('❌ Failed to connect to WebSocket:', error);
            throw error;
        }
    }

    async handleMessage(message) {
        try {
            if (!message.metadata) {
                console.error('Missing metadata in message:', message);
                return;
            }
    
            switch (message.metadata.message_type) {
                case 'session_welcome': {
                    this.sessionId = message.payload.session.id;
                    console.log('✅ WebSocket session started');
                    
                    // Notify when session is ready
                    if (this.onSessionReady) {
                        await this.onSessionReady(this.sessionId);
                    }
                    break;
                }
                case 'notification': {
                    if (message.metadata.subscription_type === 'channel.chat.message') {
                        await this.chatHandler(message.payload);
                    } else if (message.metadata.subscription_type === 'channel.channel_points_custom_reward_redemption.add') {
                        await this.redemptionHandler(message.payload);
                    } else if (message.metadata.subscription_type === 'stream.offline') {
                        await this.streamOfflineHandler();
                    }
                    break;
                }
                case 'session_reconnect': {
                    console.log('* Reconnect requested, reconnecting...');
                    await this.connect();
                    break;
                }
            }
        } catch (error) {
            console.error('❌ Error handling WebSocket message:', error);
        }
    }

    close() {
        if (this.wsConnection) {
            this.wsConnection.close();
        }
    }
}

module.exports = WebSocketManager;