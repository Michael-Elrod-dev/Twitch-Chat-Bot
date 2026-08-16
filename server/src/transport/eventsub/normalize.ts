import type { TransportEvent, ChatterIdentity } from '@almosthadai/shared';
import { SUBSCRIPTION_TYPES } from './messages.js';

/**
 * Twitch's payload shapes translated into the transport-agnostic events the
 * pipeline consumes. This is the only file in the server that knows what
 * Twitch's JSON looks like.
 */

interface Badge {
    set_id?: unknown;
    id?: unknown;
    info?: unknown;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * Roles come from badges rather than a flags object. `founder` is a legacy
 * subscriber badge — a founder who is not also badged `subscriber` is still a
 * subscriber, and missing that would silently demote long-standing supporters.
 */
export function rolesFromBadges(badges: unknown, broadcasterUserId: string, chatterUserId: string): {
    isModerator: boolean;
    isVip: boolean;
    isSubscriber: boolean;
    isBroadcaster: boolean;
} {
    const sets = new Set<string>();
    if (Array.isArray(badges)) {
        for (const badge of badges as Badge[]) {
            const setId = asString(badge?.set_id);
            if (setId) sets.add(setId);
        }
    }

    // The broadcaster is derived from the id, not trusted to be badged: a
    // broadcaster's own messages do not always carry the badge.
    const isBroadcaster = broadcasterUserId !== '' && broadcasterUserId === chatterUserId;

    return {
        isModerator: sets.has('moderator') || isBroadcaster,
        isVip: sets.has('vip'),
        isSubscriber: sets.has('subscriber') || sets.has('founder'),
        isBroadcaster
    };
}

/**
 * @param messageId the `Twitch-Eventsub-Message-Id` header — the delivery id, and
 * the dedup key. Deliberately *not* the payload's own `message_id`: a redelivery
 * repeats the delivery id, which is exactly what dedup needs to catch.
 * @returns the normalised event, or null for a subscription type this build does
 * not handle.
 */
export function normalizeEvent(
    subscriptionType: string,
    payload: Record<string, unknown>,
    messageId: string
): TransportEvent | null {
    switch (subscriptionType) {
    case SUBSCRIPTION_TYPES.chatMessage:
        return normalizeChatMessage(payload, messageId);

    case SUBSCRIPTION_TYPES.streamOnline:
        return {
            kind: 'stream_online',
            messageId,
            broadcasterTwitchId: asString(payload['broadcaster_user_id']),
            startedAt: asString(payload['started_at'])
        };

    case SUBSCRIPTION_TYPES.streamOffline:
        return {
            kind: 'stream_offline',
            messageId,
            broadcasterTwitchId: asString(payload['broadcaster_user_id'])
        };

    case SUBSCRIPTION_TYPES.redemptionAdd:
        return normalizeRedemption(payload, messageId);

    default:
        return null;
    }
}

function normalizeRedemption(payload: Record<string, unknown>, messageId: string): TransportEvent | null {
    const broadcasterTwitchId = asString(payload['broadcaster_user_id']);
    const redemptionId = asString(payload['id']);
    if (broadcasterTwitchId === '' || redemptionId === '') return null;

    const reward = payload['reward'];
    const rewardObject = typeof reward === 'object' && reward !== null
        ? (reward as Record<string, unknown>)
        : {};

    const rewardId = asString(rewardObject['id']);
    if (rewardId === '') return null;

    return {
        kind: 'redemption',
        messageId,
        broadcasterTwitchId,
        redemptionId,
        rewardId,
        rewardTitle: asString(rewardObject['title']),
        userInput: asString(payload['user_input']),
        redeemer: {
            twitchUserId: asString(payload['user_id']),
            login: asString(payload['user_login']),
            displayName: asString(payload['user_name']) || asString(payload['user_login'])
        }
    };
}

function normalizeChatMessage(payload: Record<string, unknown>, messageId: string): TransportEvent | null {
    const broadcasterTwitchId = asString(payload['broadcaster_user_id']);
    const chatterUserId = asString(payload['chatter_user_id']);
    if (broadcasterTwitchId === '' || chatterUserId === '') return null;

    const message = payload['message'];
    const text = typeof message === 'object' && message !== null
        ? asString((message as Record<string, unknown>)['text'])
        : '';

    const chatter: ChatterIdentity = {
        twitchUserId: chatterUserId,
        login: asString(payload['chatter_user_login']),
        displayName: asString(payload['chatter_user_name']) || asString(payload['chatter_user_login']),
        ...rolesFromBadges(payload['badges'], broadcasterTwitchId, chatterUserId)
    };

    const rewardId = asString(payload['channel_points_custom_reward_id']);

    return {
        kind: 'chat_message',
        messageId,
        broadcasterTwitchId,
        chatter,
        text,
        // exactOptionalPropertyTypes: an absent reward means the key is absent,
        // not present-and-undefined.
        ...(rewardId === '' ? {} : { rewardId })
    };
}
