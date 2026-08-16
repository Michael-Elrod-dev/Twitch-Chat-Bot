/**
 * The wire contract for EventSub webhook deliveries.
 *
 * Every field here is transcribed from Twitch's documentation rather than
 * remembered — see docs/PHASE1_EVENTSUB_FACTS.md §3 for the sourced facts these
 * shapes implement.
 */

/** Header names, lowercase because Node normalises incoming headers. */
export const EVENTSUB_HEADERS = {
    messageId: 'twitch-eventsub-message-id',
    messageType: 'twitch-eventsub-message-type',
    messageSignature: 'twitch-eventsub-message-signature',
    messageTimestamp: 'twitch-eventsub-message-timestamp',
    messageRetry: 'twitch-eventsub-message-retry',
    subscriptionType: 'twitch-eventsub-subscription-type',
    subscriptionVersion: 'twitch-eventsub-subscription-version'
} as const;

export const MESSAGE_TYPES = {
    notification: 'notification',
    verification: 'webhook_callback_verification',
    revocation: 'revocation'
} as const;

export type EventSubMessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

/** The subscription block that accompanies every delivery. */
export interface EventSubSubscriptionInfo {
    id: string;
    type: string;
    version: string;
    status: string;
    condition: Record<string, string>;
    created_at?: string;
}

export interface EventSubNotificationBody {
    subscription: EventSubSubscriptionInfo;
    event: Record<string, unknown>;
}

export interface EventSubVerificationBody {
    subscription: EventSubSubscriptionInfo;
    challenge: string;
}

export interface EventSubRevocationBody {
    subscription: EventSubSubscriptionInfo;
}

/** Subscription types this build understands. Anything else is logged and ignored. */
export const SUBSCRIPTION_TYPES = {
    chatMessage: 'channel.chat.message',
    streamOnline: 'stream.online',
    streamOffline: 'stream.offline',
    redemptionAdd: 'channel.channel_points_custom_reward_redemption.add'
} as const;

export type KnownSubscriptionType = (typeof SUBSCRIPTION_TYPES)[keyof typeof SUBSCRIPTION_TYPES];
