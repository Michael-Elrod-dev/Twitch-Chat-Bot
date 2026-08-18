import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import type { TransportEvent } from '@almosthadai/shared';
import { createApp } from '../../http/app.js';
import { createEventSubRouter, EVENTSUB_WEBHOOK_PATH } from './webhook.js';
import { EVENTSUB_HEADERS, MESSAGE_TYPES, type EventSubSubscriptionInfo } from './messages.js';
import {
    chatMessageDelivery,
    streamOnlineDelivery,
    verificationDelivery,
    revocationDelivery,
    signRaw,
    type SignedDelivery
} from './synthetic.js';

/**
 * The webhook is the server's only unauthenticated public surface, so these
 * tests are written from the attacker's side as much as the happy path.
 */

const logger = pino({ level: 'silent' });
const SECRET = 'test-eventsub-secret-value';

interface Harness {
    app: ReturnType<typeof createApp>;
    events: TransportEvent[];
    revocations: EventSubSubscriptionInfo[];
}

function buildHarness(overrides: {
    onEvent?: (event: TransportEvent) => boolean;
    onRevocation?: (subscription: EventSubSubscriptionInfo) => void;
} = {}): Harness {
    const events: TransportEvent[] = [];
    const revocations: EventSubSubscriptionInfo[] = [];

    const router = createEventSubRouter({
        secret: SECRET,
        logger,
        maxSkewMs: 600_000,
        onEvent: overrides.onEvent ?? ((event) => { events.push(event); return true; }),
        onRevocation: overrides.onRevocation ?? ((subscription) => { revocations.push(subscription); })
    });

    return { app: createApp({ logger, version: 'test', rawBodyRouters: [router] }), events, revocations };
}

describe('EventSub webhook', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = buildHarness();
    });

    const post = (delivery: SignedDelivery, app = harness.app) =>
        request(app).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body);

    describe('signature verification', () => {
        it('accepts a correctly signed notification', async () => {
            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' })).expect(204);

            expect(harness.events).toHaveLength(1);
            expect(harness.events[0]).toMatchObject({ kind: 'chat_message', broadcasterTwitchId: '1001' });
        });

        it('rejects a delivery signed with the wrong secret', async () => {
            await post(chatMessageDelivery('a-completely-different-secret', {
                broadcasterUserId: '1001', text: '!discord'
            })).expect(403);

            expect(harness.events).toHaveLength(0);
        });

        it('rejects a body altered after signing', async () => {
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: '!discord' });
            const tampered = delivery.body.replace('!discord', '!giveaway');

            await request(harness.app)
                .post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(tampered)
                .expect(403);

            expect(harness.events).toHaveLength(0);
        });

        it('rejects a delivery with no signature header', async () => {
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' });
            const headers = { ...delivery.headers };
            delete headers[EVENTSUB_HEADERS.messageSignature];

            await request(harness.app).post(EVENTSUB_WEBHOOK_PATH).set(headers).send(delivery.body).expect(400);
        });

        it('rejects a delivery missing the message id', async () => {
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' });
            const headers = { ...delivery.headers };
            delete headers[EVENTSUB_HEADERS.messageId];

            await request(harness.app).post(EVENTSUB_WEBHOOK_PATH).set(headers).send(delivery.body).expect(400);
        });
    });

    describe('replay guard', () => {
        it('rejects a delivery older than the accepted window', async () => {
            const old = new Date(Date.now() - 20 * 60_000).toISOString();

            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' }, 'replayed', old))
                .expect(403);

            expect(harness.events).toHaveLength(0);
        });

        it('accepts a delivery inside the window', async () => {
            const recent = new Date(Date.now() - 60_000).toISOString();

            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' }, 'recent', recent))
                .expect(204);
        });

        it('checks the signature before the timestamp', async () => {
            // An unsigned request does not get to tell us what time it is.
            const old = new Date(Date.now() - 20 * 60_000).toISOString();
            const response = await post(
                chatMessageDelivery('wrong-secret-entirely', { broadcasterUserId: '1001', text: 'hi' }, 'm', old)
            );

            expect(response.status).toBe(403);
            expect(response.text).toBe('invalid signature');
        });
    });

    describe('deduplication', () => {
        it('processes a redelivered message only once', async () => {
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' }, 'same-delivery');

            await post(delivery).expect(204);
            // Still a 2xx: a non-2xx would make Twitch retry a message we have.
            await post(delivery).expect(204);

            expect(harness.events).toHaveLength(1);
        });

        it('processes distinct deliveries', async () => {
            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'a' }, 'd1')).expect(204);
            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'b' }, 'd2')).expect(204);

            expect(harness.events).toHaveLength(2);
        });
    });

    describe('challenge verification', () => {
        it('echoes the challenge as plain text with a correct Content-Length', async () => {
            const challenge = 'pogchamp-challenge-value';

            const response = await post(verificationDelivery(SECRET, challenge)).expect(200);

            expect(response.text).toBe(challenge);
            expect(response.headers['content-type']).toContain('text/plain');
            expect(response.headers['content-length']).toBe(String(Buffer.byteLength(challenge)));
        });

        it('does not echo a challenge on an invalid signature', async () => {
            // Echoing would enable the subscription for whoever asked.
            const response = await post(verificationDelivery('wrong-secret-entirely', 'do-not-echo'));

            expect(response.status).toBe(403);
            expect(response.text).not.toContain('do-not-echo');
        });

        it('rejects a verification with no challenge in the body', async () => {
            await post(verificationDelivery(SECRET, '')).expect(400);
        });
    });

    describe('revocation', () => {
        it('reports the revoked subscription and acknowledges', async () => {
            await post(revocationDelivery(SECRET, '1001', 'authorization_revoked')).expect(204);

            expect(harness.revocations).toHaveLength(1);
            expect(harness.revocations[0]).toMatchObject({
                status: 'authorization_revoked',
                condition: { broadcaster_user_id: '1001' }
            });
        });

        it('still acknowledges when the revocation handler throws', async () => {
            // Twitch does not retry revocations, so failing here would turn a
            // known-bad state into a silently lost notice.
            const thrower = buildHarness({
                onRevocation: () => { throw new Error('bookkeeping exploded'); }
            });

            await post(revocationDelivery(SECRET, '1001'), thrower.app).expect(204);
        });
    });

    describe('unhandled input', () => {
        it('acknowledges a subscription type it does not normalize', async () => {
            const body = JSON.stringify({
                subscription: { id: 'x', type: 'channel.follow', version: '1', status: 'enabled', condition: {} },
                event: { broadcaster_user_id: '1001' }
            });

            // Signed correctly, so this tests type handling and nothing else.
            await post(signRaw(SECRET, MESSAGE_TYPES.notification, body)).expect(204);

            expect(harness.events).toHaveLength(0);
        });

        it('acknowledges an unknown message type', async () => {
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'x' });
            const headers = { ...delivery.headers, [EVENTSUB_HEADERS.messageType]: 'something_new' };

            await request(harness.app).post(EVENTSUB_WEBHOOK_PATH).set(headers).send(delivery.body).expect(204);

            expect(harness.events).toHaveLength(0);
        });

        it('normalizes stream.online through the same path', async () => {
            await post(streamOnlineDelivery(SECRET, '1001')).expect(204);

            expect(harness.events[0]).toMatchObject({ kind: 'stream_online', broadcasterTwitchId: '1001' });
        });
    });

    describe('backpressure', () => {
        it('answers 503 when the queue refuses the event, so Twitch retries', async () => {
            const full = buildHarness({ onEvent: () => false });

            await post(chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' }), full.app).expect(503);
        });
    });

    describe('body-parser ordering', () => {
        it('never acknowledges a delivery whose signature could not be checked', async () => {
            const router = createEventSubRouter({
                secret: SECRET, logger, maxSkewMs: 600_000,
                onEvent: () => true,
                onRevocation: () => undefined
            });

            // Mounted the wrong way round, so createApp's global express.json()
            // consumes the stream first and the raw bytes are gone.
            const misordered = createApp({ logger, version: 'test' });
            misordered.use(router);

            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1001', text: 'hi' });
            const response = await request(misordered)
                .post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body);

            // 404 (the catch-all wins) or 400 (the guard fires) - never a 204
            // pretending the signature was verified.
            expect([400, 404]).toContain(response.status);
        });
    });
});
