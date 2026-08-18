import { randomUUID } from 'node:crypto';
import { EVENTSUB_HEADERS, MESSAGE_TYPES, SUBSCRIPTION_TYPES } from './messages.js';
import { computeSignature } from './signature.js';

/**
 * Builds correctly-signed synthetic EventSub deliveries.
 *
 * One builder serves both the tests and the local dev loop, deliberately: if the
 * dev loop signed events differently from the tests, a green suite would stop
 * being evidence that the endpoint works. It signs with the same function the
 * handler verifies with, so a change to the scheme cannot pass unnoticed.
 */

export interface SignedDelivery {
    headers: Record<string, string>;
    body: string;
}

export interface ChatMessageOptions {
    broadcasterUserId: string;
    text: string;
    chatterUserId?: string;
    chatterLogin?: string;
    chatterDisplayName?: string;
    badges?: { set_id: string; id: string; info: string }[];
    rewardId?: string | null;
    botUserId?: string;
}

/**
 * Signs an already-serialized body.
 *
 * Exposed because a test that hand-builds a payload must still be able to sign
 * it correctly — otherwise it would only ever prove that the signature check
 * works, never the thing it meant to test.
 */
export function signRaw(
    secret: string,
    messageType: string,
    rawBody: string,
    messageId: string = randomUUID(),
    timestamp: string = new Date().toISOString()
): SignedDelivery {
    const signature = computeSignature({
        secret,
        messageId,
        timestamp,
        rawBody: Buffer.from(rawBody, 'utf8')
    });

    return {
        headers: {
            'content-type': 'application/json',
            [EVENTSUB_HEADERS.messageId]: messageId,
            [EVENTSUB_HEADERS.messageType]: messageType,
            [EVENTSUB_HEADERS.messageTimestamp]: timestamp,
            [EVENTSUB_HEADERS.messageSignature]: signature,
            [EVENTSUB_HEADERS.messageRetry]: '0'
        },
        body: rawBody
    };
}

function sign(secret: string, messageType: string, body: unknown, messageId: string, timestamp: string): SignedDelivery {
    return signRaw(secret, messageType, JSON.stringify(body), messageId, timestamp);
}

export function chatMessageDelivery(
    secret: string,
    options: ChatMessageOptions,
    messageId: string = randomUUID(),
    timestamp: string = new Date().toISOString()
): SignedDelivery {
    const chatterUserId = options.chatterUserId ?? '55555';
    const chatterLogin = options.chatterLogin ?? 'testviewer';

    const body = {
        subscription: {
            id: randomUUID(),
            type: SUBSCRIPTION_TYPES.chatMessage,
            version: '1',
            status: 'enabled',
            condition: {
                broadcaster_user_id: options.broadcasterUserId,
                user_id: options.botUserId ?? 'bot-user-id'
            }
        },
        event: {
            broadcaster_user_id: options.broadcasterUserId,
            broadcaster_user_login: `broadcaster${options.broadcasterUserId}`,
            broadcaster_user_name: `Broadcaster${options.broadcasterUserId}`,
            chatter_user_id: chatterUserId,
            chatter_user_login: chatterLogin,
            chatter_user_name: options.chatterDisplayName ?? chatterLogin,
            message_id: randomUUID(),
            message: { text: options.text, fragments: [{ type: 'text', text: options.text }] },
            message_type: 'text',
            badges: options.badges ?? [],
            cheer: null,
            color: '#FF0000',
            reply: null,
            channel_points_custom_reward_id: options.rewardId ?? null
        }
    };

    return sign(secret, MESSAGE_TYPES.notification, body, messageId, timestamp);
}

export function streamOnlineDelivery(
    secret: string,
    broadcasterUserId: string,
    messageId: string = randomUUID(),
    timestamp: string = new Date().toISOString()
): SignedDelivery {
    const body = {
        subscription: {
            id: randomUUID(),
            type: SUBSCRIPTION_TYPES.streamOnline,
            version: '1',
            status: 'enabled',
            condition: { broadcaster_user_id: broadcasterUserId }
        },
        event: {
            id: '9001',
            broadcaster_user_id: broadcasterUserId,
            broadcaster_user_login: `broadcaster${broadcasterUserId}`,
            broadcaster_user_name: `Broadcaster${broadcasterUserId}`,
            type: 'live',
            started_at: timestamp
        }
    };

    return sign(secret, MESSAGE_TYPES.notification, body, messageId, timestamp);
}

export function verificationDelivery(
    secret: string,
    challenge: string,
    broadcasterUserId = '1001',
    messageId: string = randomUUID(),
    timestamp: string = new Date().toISOString()
): SignedDelivery {
    const body = {
        challenge,
        subscription: {
            id: randomUUID(),
            type: SUBSCRIPTION_TYPES.chatMessage,
            version: '1',
            status: 'webhook_callback_verification_pending',
            condition: { broadcaster_user_id: broadcasterUserId, user_id: 'bot-user-id' }
        }
    };

    return sign(secret, MESSAGE_TYPES.verification, body, messageId, timestamp);
}

export function revocationDelivery(
    secret: string,
    broadcasterUserId: string,
    status = 'authorization_revoked',
    messageId: string = randomUUID(),
    timestamp: string = new Date().toISOString()
): SignedDelivery {
    const body = {
        subscription: {
            id: randomUUID(),
            type: SUBSCRIPTION_TYPES.chatMessage,
            version: '1',
            status,
            condition: { broadcaster_user_id: broadcasterUserId, user_id: 'bot-user-id' }
        }
    };

    return sign(secret, MESSAGE_TYPES.revocation, body, messageId, timestamp);
}
