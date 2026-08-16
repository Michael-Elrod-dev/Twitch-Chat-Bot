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

/**
 * A channel-point redemption.
 *
 * `rewardId` is the routing key — never the title. A reward renamed in the
 * Twitch dashboard keeps working; two rewards with similar names stay distinct.
 */
export interface RedemptionEvent {
    kind: 'redemption';
    messageId: string;
    broadcasterTwitchId: string;
    /** Twitch's redemption id, needed to fulfil or refund it. */
    redemptionId: string;
    rewardId: string;
    rewardTitle: string;
    /** What the viewer typed, when the reward takes input. */
    userInput: string;
    redeemer: {
        twitchUserId: string;
        login: string;
        displayName: string;
    };
}

export type TransportEvent =
    | ChatMessageEvent
    | StreamOnlineEvent
    | StreamOfflineEvent
    | RedemptionEvent;
