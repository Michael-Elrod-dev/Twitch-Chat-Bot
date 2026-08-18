import { describe, it, expect } from 'vitest';
import { normalizeEvent, rolesFromBadges } from './normalize.js';
import { SUBSCRIPTION_TYPES } from './messages.js';

const badge = (setId: string): { set_id: string; id: string; info: string } => ({ set_id: setId, id: '1', info: '' });

const chatPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    broadcaster_user_id: '1001',
    broadcaster_user_login: 'alpha',
    broadcaster_user_name: 'Alpha',
    chatter_user_id: '55555',
    chatter_user_login: 'viewer',
    chatter_user_name: 'Viewer',
    message_id: 'payload-message-id',
    message: { text: '!discord', fragments: [] },
    badges: [],
    channel_points_custom_reward_id: null,
    ...overrides
});

describe('rolesFromBadges', () => {
    it('reads moderator and vip from badge set ids', () => {
        expect(rolesFromBadges([badge('moderator'), badge('vip')], '1001', '55555')).toMatchObject({
            isModerator: true,
            isVip: true
        });
    });

    it('treats a founder badge as a subscriber', () => {
        // `founder` is the legacy subscriber badge. Missing it would silently
        // demote a channel's longest-standing supporters.
        expect(rolesFromBadges([badge('founder')], '1001', '55555').isSubscriber).toBe(true);
    });

    it('derives broadcaster from the id rather than the badge', () => {
        // A broadcaster's own messages do not reliably carry the badge.
        const roles = rolesFromBadges([], '1001', '1001');

        expect(roles.isBroadcaster).toBe(true);
        expect(roles.isModerator).toBe(true);
    });

    it('gives a plain viewer nothing', () => {
        expect(rolesFromBadges([], '1001', '55555')).toEqual({
            isModerator: false,
            isVip: false,
            isSubscriber: false,
            isBroadcaster: false
        });
    });

    it('survives a missing or malformed badge array', () => {
        expect(rolesFromBadges(undefined, '1001', '55555').isModerator).toBe(false);
        expect(rolesFromBadges('not an array', '1001', '55555').isVip).toBe(false);
        expect(rolesFromBadges([{ nonsense: true }], '1001', '55555').isSubscriber).toBe(false);
    });
});

describe('normalizeEvent', () => {
    it('normalizes a chat message', () => {
        const event = normalizeEvent(SUBSCRIPTION_TYPES.chatMessage, chatPayload(), 'delivery-1');

        expect(event).toMatchObject({
            kind: 'chat_message',
            messageId: 'delivery-1',
            broadcasterTwitchId: '1001',
            text: '!discord',
            chatter: { twitchUserId: '55555', login: 'viewer', displayName: 'Viewer' }
        });
    });

    it('uses the delivery id, not the payload message id, as the dedup key', () => {
        // A redelivery repeats the delivery id, which is what dedup must catch.
        const event = normalizeEvent(SUBSCRIPTION_TYPES.chatMessage, chatPayload(), 'delivery-1');

        expect(event?.messageId).toBe('delivery-1');
        expect(event?.messageId).not.toBe('payload-message-id');
    });

    it('carries a reward id through when the message was a redemption', () => {
        const event = normalizeEvent(
            SUBSCRIPTION_TYPES.chatMessage,
            chatPayload({ channel_points_custom_reward_id: 'reward-7' }),
            'd'
        );

        expect(event).toMatchObject({ rewardId: 'reward-7' });
    });

    it('omits rewardId entirely when there is none', () => {
        // Not present-and-undefined: the pipeline's reward check is a truthiness
        // test, and exactOptionalPropertyTypes forbids the sloppier shape.
        const event = normalizeEvent(SUBSCRIPTION_TYPES.chatMessage, chatPayload(), 'd');

        expect(event && 'rewardId' in event).toBe(false);
    });

    it('falls back to the login when no display name is set', () => {
        const event = normalizeEvent(
            SUBSCRIPTION_TYPES.chatMessage,
            chatPayload({ chatter_user_name: '' }),
            'd'
        );

        expect(event).toMatchObject({ chatter: { displayName: 'viewer' } });
    });

    it('rejects a chat payload with no broadcaster or chatter', () => {
        expect(normalizeEvent(SUBSCRIPTION_TYPES.chatMessage, chatPayload({ broadcaster_user_id: '' }), 'd')).toBeNull();
        expect(normalizeEvent(SUBSCRIPTION_TYPES.chatMessage, chatPayload({ chatter_user_id: '' }), 'd')).toBeNull();
    });

    it('normalizes stream.online and stream.offline', () => {
        expect(normalizeEvent(SUBSCRIPTION_TYPES.streamOnline, {
            id: '48765430',
            broadcaster_user_id: '1001',
            started_at: '2026-08-15T12:00:00Z'
        }, 'd')).toEqual({
            kind: 'stream_online',
            messageId: 'd',
            broadcasterTwitchId: '1001',
            // `id` on this payload is Twitch's stream id, NOT the event id -
            // reading the wrong one would key every stream row on a value that
            // changes per delivery.
            streamId: '48765430',
            startedAt: '2026-08-15T12:00:00Z'
        });

        expect(normalizeEvent(SUBSCRIPTION_TYPES.streamOffline, { broadcaster_user_id: '1001' }, 'd')).toEqual({
            kind: 'stream_offline',
            messageId: 'd',
            broadcasterTwitchId: '1001'
        });
    });

    it('returns null for a subscription type this build does not handle', () => {
        expect(normalizeEvent('channel.follow', { broadcaster_user_id: '1001' }, 'd')).toBeNull();
    });
});
