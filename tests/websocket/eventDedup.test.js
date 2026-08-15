/**
 * P1-7: EventSub is at-least-once, so redeliveries must be dropped.
 */

jest.mock('ws');

describe('P1-7: EventSub duplicate delivery', () => {
    const WebSocketManager = require('../../src/websocket/webSocketManager');
    let manager;
    let onStreamOnline;
    let onChatMessage;

    const notification = (messageId, type = 'stream.online') => ({
        metadata: {
            message_id: messageId,
            message_type: 'notification',
            subscription_type: type
        },
        payload: { event: {} }
    });

    beforeEach(() => {
        onStreamOnline = jest.fn().mockResolvedValue(undefined);
        onChatMessage = jest.fn().mockResolvedValue(undefined);
        manager = new WebSocketManager({
            tokenManager: { tokens: {} },
            onStreamOnline,
            onChatMessage
        });
    });

    it('should dispatch a message the first time', async () => {
        await manager.handleMessage(notification('msg-1'));

        expect(onStreamOnline).toHaveBeenCalledTimes(1);
    });

    it('should drop a redelivery of the same message', async () => {
        // Twitch documents EventSub as at-least-once, so redeliveries are expected.
        await manager.handleMessage(notification('msg-1'));
        await manager.handleMessage(notification('msg-1'));
        await manager.handleMessage(notification('msg-1'));

        expect(onStreamOnline).toHaveBeenCalledTimes(1);
    });

    it('should dedup across notification types', async () => {
        await manager.handleMessage(notification('msg-2', 'channel.chat.message'));
        await manager.handleMessage(notification('msg-2', 'channel.chat.message'));

        expect(onChatMessage).toHaveBeenCalledTimes(1);
    });

    it('should still dispatch distinct messages', async () => {
        await manager.handleMessage(notification('msg-1'));
        await manager.handleMessage(notification('msg-2'));

        expect(onStreamOnline).toHaveBeenCalledTimes(2);
    });

    it('should not choke on a message without an id', async () => {
        await manager.handleMessage(notification(undefined));
        await manager.handleMessage(notification(undefined));

        expect(onStreamOnline).toHaveBeenCalledTimes(2);
    });

    it('should bound the id history', async () => {
        for (let i = 0; i < 1200; i++) {
            manager.isDuplicate(`id-${i}`);
        }

        expect(manager.seenMessageIds.size).toBeLessThanOrEqual(1000);
    });

    it('should evict oldest first', async () => {
        for (let i = 0; i < 1001; i++) {
            manager.isDuplicate(`id-${i}`);
        }

        expect(manager.seenMessageIds.has('id-0')).toBe(false);
        expect(manager.seenMessageIds.has('id-1000')).toBe(true);
    });
});
