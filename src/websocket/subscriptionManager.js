// src/websocket/subscriptionManager.js

const fetch = require('node-fetch');
const config = require('../config/config');

class SubscriptionManager {
    constructor(tokenManager, sessionId) {
        this.tokenManager = tokenManager;
        this.sessionId = sessionId;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async subscribeToChatEvents() {
        try {
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
                throw new Error(`Failed to subscribe to chat events: ${JSON.stringify(responseData)}`);
            }

            console.log('✅ Subscribed to chat events');
        } catch (error) {
            console.error('❌ Error subscribing to chat events:', error);
            throw error;
        }
    }

    async subscribeToChannelPoints() {
        try {
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
                throw new Error(`Failed to subscribe to channel points: ${JSON.stringify(responseData)}`);
            }

            console.log('✅ Subscribed to channel point redemptions');
        } catch (error) {
            console.error('❌ Error subscribing to channel points:', error);
            throw error;
        }
    }

    async subscribeToStreamOnline() {
        try {
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
                throw new Error(`Failed to subscribe to stream online events: ${JSON.stringify(responseData)}`);
            }

            console.log('✅ Subscribed to stream online events');
        } catch (error) {
            console.error('❌ Error subscribing to stream online events:', error);
            throw error;
        }
    }

    async subscribeToStreamOffline() {
        try {
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
                throw new Error(`Failed to subscribe to stream offline events: ${JSON.stringify(responseData)}`);
            }

            console.log('✅ Subscribed to stream offline events');
        } catch (error) {
            console.error('❌ Error subscribing to stream offline events:', error);
            throw error;
        }
    }

    async unsubscribeFromChatEvents() {
        try {
            await this.unsubscribeFromEventType('channel.chat.message');
            console.log('✅ Unsubscribed from chat events');
        } catch (error) {
            console.error('❌ Error unsubscribing from chat events:', error);
            throw error;
        }
    }

    async unsubscribeFromChannelPoints() {
        try {
            await this.unsubscribeFromEventType('channel.channel_points_custom_reward_redemption.add');
            console.log('✅ Unsubscribed from channel point redemptions');
        } catch (error) {
            console.error('❌ Error unsubscribing from channel points:', error);
            throw error;
        }
    }

    // Helper method to handle the actual unsubscription logic
    async unsubscribeFromEventType(eventType) {
        try {
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
                throw new Error(`Failed to get subscriptions: ${JSON.stringify(errorData)}`);
            }

            const subscriptionsData = await subscriptionsResponse.json();

            // Find the subscription for this event type and session
            const subscription = subscriptionsData.data.find(sub =>
                sub.type === eventType &&
                sub.transport.session_id === this.sessionId
            );

            if (!subscription) {
                console.log(`ℹ️ No subscription found for ${eventType} with session ${this.sessionId}`);
                return;
            }

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
                throw new Error(`Failed to delete subscription ${subscription.id}: ${JSON.stringify(errorData)}`);
            }

            console.log(`✅ Successfully unsubscribed from ${eventType} (ID: ${subscription.id})`);

        } catch (error) {
            console.error(`❌ Error unsubscribing from ${eventType}:`, error);
            throw error;
        }
    }
}

module.exports = SubscriptionManager;
