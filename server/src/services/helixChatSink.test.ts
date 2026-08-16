import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { HelixChatSink } from './helixChatSink.js';
import type { HelixApi } from '../twitch/helixApi.js';
import { HelixError, RateLimitedError } from '../twitch/errors.js';

const logger = pino({ level: 'silent' });
const BOT_ID = 'bot-999';

type SendFn = (broadcasterId: string, senderId: string, message: string) => Promise<{ sent: boolean; dropReason?: string }>;

const buildSink = (
    sendChatMessage: ReturnType<typeof vi.fn<SendFn>>,
    botUserId = BOT_ID
): HelixChatSink =>
    new HelixChatSink({ helix: { sendChatMessage } as unknown as HelixApi, botUserId, logger });

const message = { channelId: 'c1', broadcasterTwitchId: '1001', text: 'hello chat' };

describe('HelixChatSink', () => {
    it('sends with the broadcaster and the shared bot as sender', async () => {
        const send = vi.fn<SendFn>(async () => ({ sent: true }));

        await buildSink(send).send(message);

        // The app-token model: one bot identity is the sender in every channel.
        expect(send).toHaveBeenCalledWith('1001', BOT_ID, 'hello chat');
    });

    it('truncates an over-long message rather than letting Twitch cut it', async () => {
        const send = vi.fn<SendFn>(async () => ({ sent: true }));

        await buildSink(send).send({ ...message, text: 'x'.repeat(600) });

        const sent = send.mock.calls[0]?.[2] as string;
        expect(sent.length).toBe(500);
        expect(sent.endsWith('…')).toBe(true);
    });

    it('leaves a message at the limit alone', async () => {
        const send = vi.fn<SendFn>(async () => ({ sent: true }));

        await buildSink(send).send({ ...message, text: 'y'.repeat(500) });

        expect(send.mock.calls[0]?.[2]).toBe('y'.repeat(500));
    });

    describe('failures never reach the pipeline', () => {
        it('swallows a rate limit', async () => {
            // One channel being unable to speak is not a reason to stop
            // processing its messages, let alone anyone else's.
            const send = vi.fn<SendFn>(async () => { throw new RateLimitedError('/chat/messages', 5000); });

            await expect(buildSink(send).send(message)).resolves.toBeUndefined();
        });

        it('swallows an unauthorized send', async () => {
            const send = vi.fn<SendFn>(async () => { throw new HelixError('/chat/messages', 401, 'Invalid OAuth token'); });

            await expect(buildSink(send).send(message)).resolves.toBeUndefined();
        });

        it('swallows an unexpected failure', async () => {
            const send = vi.fn<SendFn>(async () => { throw new Error('socket hang up'); });

            await expect(buildSink(send).send(message)).resolves.toBeUndefined();
        });
    });

    it('reports an accepted-but-dropped message instead of claiming success', async () => {
        // AutoMod accepts and then drops; a silent drop would look exactly like
        // a bug in whatever produced the message.
        const send = vi.fn<SendFn>(async () => ({ sent: false, dropReason: 'held by AutoMod' }));

        await expect(buildSink(send).send(message)).resolves.toBeUndefined();
        expect(send).toHaveBeenCalled();
    });

    it('does not attempt a send with no bot identity', async () => {
        // sender_id would be empty, which Twitch rejects; failing here says why.
        const send = vi.fn<SendFn>(async () => ({ sent: true }));

        await buildSink(send, '').send(message);

        expect(send).not.toHaveBeenCalled();
    });
});
