// src/websocket/subscriptionManager.js

const fetch = require('node-fetch');
const config = require('../config/config');
const logger = require('../logger/logger');

class SubscriptionManager {
    constructor(tokenManager, sessionId) {
        this.tokenManager = tokenManager;
        this.sessionId = sessionId;
        logger.debug('SubscriptionManager', 'SubscriptionManager instance created', { sessionId });
    }

    setSessionId(sessionId) {
        logger.debug('SubscriptionManager', 'Session ID updated', { oldSessionId: this.sessionId, newSessionId: sessionId });
        this.sessionId = sessionId;
    }

    async subscribeToChatEvents() {
        try {
            logger.debug('SubscriptionManager', 'Subscribing to chat events');

            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.userId) {
                throw new Error('Missing required IDs');
            }

            const subscription = {
                type: 'channel.chat.message',
                version: '1',
                condition: {
                    broadcaster_user_id: this.tokenManager.tokens.channelId,
                    user_id: this.tokenManager.tokens.userId
                },
                transport: {
                    method: 'websocket',
                    session_id: this.sessionId
                }
            };

            const response = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(subscription)
            });

            const responseData = await response.json();

            if (!response.ok) {
                logger.error('SubscriptionManager', 'Failed to subscribe to chat events', {
                    status: response.status,
                    error: JSON.stringify(responseData)
                });
                throw new Error(`Failed to subscribe to chat events: ${JSON.stringify(responseData)}`);
            }

            logger.info('SubscriptionManager', 'Subscribed to chat events', { subscriptionId: responseData.data?.[0]?.id });
        } catch (error) {
            logger.error('SubscriptionManager', 'Error subscribing to chat events', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async subscribeToChannelPoints() {
        try {
            logger.debug('SubscriptionManager', 'Subscribing to channel point redemptions');

            if (!this.tokenManager.tokens.channelId || !this.tokenManager.tokens.userId) {
                throw new Error('Missing required IDs');
            }

            const subscription = {
                type: 'channel.channel_points_custom_reward_redemption.add',
                version: '1',
                condition: {
                    broadcaster_user_id: this.tokenManager.tokens.channelId
                },
                transport: {
                    method: 'websocket',
                    session_id: this.sessionId
                }
            };

            const response = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(subscription)
            });

            const responseData = await response.json();

            if (!response.ok) {
                logger.error('SubscriptionManager', 'Failed to subscribe to channel points', {
                    status: response.status,
                    error: JSON.stringify(responseData)
                });
                throw new Error(`Failed to subscribe to channel points: ${JSON.stringify(responseData)}`);
            }

            logger.info('SubscriptionManager', 'Subscribed to channel point redemptions', { subscriptionId: responseData.data?.[0]?.id });
        } catch (error) {
            logger.error('SubscriptionManager', 'Error subscribing to channel points', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async subscribeToStreamOnline() {
        try {
            logger.debug('SubscriptionManager', 'Subscribing to stream online events');

            if (!this.tokenManager.tokens.channelId) {
                throw new Error('Missing required channel ID');
            }

            const subscription = {
                type: 'stream.online',
                version: '1',
                condition: {
                    broadcaster_user_id: this.tokenManager.tokens.channelId
                },
                transport: {
                    method: 'websocket',
                    session_id: this.sessionId
                }
            };

            const response = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(subscription)
            });

            const responseData = await response.json();

            if (!response.ok) {
                logger.error('SubscriptionManager', 'Failed to subscribe to stream online events', {
                    status: response.status,
                    error: JSON.stringify(responseData)
                });
                throw new Error(`Failed to subscribe to stream online events: ${JSON.stringify(responseData)}`);
            }

            logger.info('SubscriptionManager', 'Subscribed to stream online events', { subscriptionId: responseData.data?.[0]?.id });
        } catch (error) {
            logger.error('SubscriptionManager', 'Error subscribing to stream online events', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async subscribeToStreamOffline() {
        try {
            logger.debug('SubscriptionManager', 'Subscribing to stream offline events');

            if (!this.tokenManager.tokens.channelId) {
                throw new Error('Missing required channel ID');
            }

            const subscription = {
                type: 'stream.offline',
                version: '1',
                condition: {
                    broadcaster_user_id: this.tokenManager.tokens.channelId
                },
                transport: {
                    method: 'websocket',
                    session_id: this.sessionId
                }
            };

            const response = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'POST',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(subscription)
            });

            const responseData = await response.json();

            if (!response.ok) {
                logger.error('SubscriptionManager', 'Failed to subscribe to stream offline events', {
                    status: response.status,
                    error: JSON.stringify(responseData)
                });
                throw new Error(`Failed to subscribe to stream offline events: ${JSON.stringify(responseData)}`);
            }

            logger.info('SubscriptionManager', 'Subscribed to stream offline events', { subscriptionId: responseData.data?.[0]?.id });
        } catch (error) {
            logger.error('SubscriptionManager', 'Error subscribing to stream offline events', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async unsubscribeFromChatEvents() {
        try {
            logger.debug('SubscriptionManager', 'Unsubscribing from chat events');
            await this.unsubscribeFromEventType('channel.chat.message');
            logger.info('SubscriptionManager', 'Unsubscribed from chat events');
        } catch (error) {
            logger.error('SubscriptionManager', 'Error unsubscribing from chat events', { error: error.message });
            throw error;
        }
    }

    async unsubscribeFromChannelPoints() {
        try {
            logger.debug('SubscriptionManager', 'Unsubscribing from channel point redemptions');
            await this.unsubscribeFromEventType('channel.channel_points_custom_reward_redemption.add');
            logger.info('SubscriptionManager', 'Unsubscribed from channel point redemptions');
        } catch (error) {
            logger.error('SubscriptionManager', 'Error unsubscribing from channel points', { error: error.message });
            throw error;
        }
    }

    // Helper method to handle the actual unsubscription logic
    async unsubscribeFromEventType(eventType) {
        try {
            logger.debug('SubscriptionManager', 'Fetching subscriptions to unsubscribe', { eventType });

            // First, get all subscriptions to find the one we want to delete
            const subscriptionsResponse = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions`, {
                method: 'GET',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!subscriptionsResponse.ok) {
                const errorData = await subscriptionsResponse.json();
                logger.error('SubscriptionManager', 'Failed to fetch subscriptions', {
                    status: subscriptionsResponse.status,
                    error: JSON.stringify(errorData)
                });
                throw new Error(`Failed to get subscriptions: ${JSON.stringify(errorData)}`);
            }

            const subscriptionsData = await subscriptionsResponse.json();

            // Find the subscription for this event type and session
            const subscription = subscriptionsData.data.find(sub =>
                sub.type === eventType &&
                sub.transport.session_id === this.sessionId
            );

            if (!subscription) {
                logger.info('SubscriptionManager', 'No subscription found to unsubscribe', { eventType, sessionId: this.sessionId });
                return;
            }

            logger.debug('SubscriptionManager', 'Deleting subscription', { eventType, subscriptionId: subscription.id });

            // Delete the subscription
            const deleteResponse = await fetch(`${config.twitchApiEndpoint}/eventsub/subscriptions?id=${subscription.id}`, {
                method: 'DELETE',
                headers: {
                    'Client-Id': this.tokenManager.tokens.clientId,
                    'Authorization': `Bearer ${this.tokenManager.tokens.broadcasterAccessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!deleteResponse.ok) {
                const errorData = await deleteResponse.json();
                logger.error('SubscriptionManager', 'Failed to delete subscription', {
                    subscriptionId: subscription.id,
                    status: deleteResponse.status,
                    error: JSON.stringify(errorData)
                });
                throw new Error(`Failed to delete subscription ${subscription.id}: ${JSON.stringify(errorData)}`);
            }

            logger.info('SubscriptionManager', 'Successfully unsubscribed', { eventType, subscriptionId: subscription.id });

        } catch (error) {
            logger.error('SubscriptionManager', 'Error in unsubscribe process', { eventType, error: error.message });
            throw error;
        }
    }
}

module.exports = SubscriptionManager;
