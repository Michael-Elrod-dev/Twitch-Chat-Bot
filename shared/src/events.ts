/**
 * Normalised event shapes the pipeline consumes.
 *
 * Deliberately transport-agnostic: EventSub webhooks, the dev websocket, and the
 * test fake all produce these, so nothing downstream knows how an event arrived.
 */

export interface ChatterIdentity {
    twitchUserId: string;
    login: string;
    displayName: string;
    isModerator: boolean;
    isVip: boolean;
    isSubscriber: boolean;
    isBroadcaster: boolean;
}

export interface ChatMessageEvent {
    kind: 'chat_message';
    /** EventSub's metadata.message_id - the dedup key. */
    messageId: string;
    broadcasterTwitchId: string;
    chatter: ChatterIdentity;
    text: string;
    /** Set when the message was attached to a channel-point reward. */
    rewardId?: string;
}

export interface StreamOnlineEvent {
    kind: 'stream_online';
    messageId: string;
    broadcasterTwitchId: string;
    startedAt: string;
}

export interface StreamOfflineEvent {
    kind: 'stream_offline';
    messageId: string;
    broadcasterTwitchId: string;
}

export type TransportEvent = ChatMessageEvent | StreamOnlineEvent | StreamOfflineEvent;
