import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import type { TransportEvent } from '@almosthadai/shared';
import { createApp } from '../../http/app.js';
import { EventSubWebhookTransport } from './webhookTransport.js';
import { EVENTSUB_WEBHOOK_PATH } from './webhook.js';
import { SubscriptionReconciler } from './subscriptionReconciler.js';
import { FakeHelixClient } from './helixClient.js';
import { chatMessageDelivery } from './synthetic.js';

const logger = pino({ level: 'silent' });
const SECRET = 'transport-test-secret-value';

describe('EventSubWebhookTransport', () => {
    let helix: FakeHelixClient;
    let transport: EventSubWebhookTransport;

    const build = (dryRun: boolean): EventSubWebhookTransport => {
        helix = new FakeHelixClient();
        return new EventSubWebhookTransport({
            secret: SECRET,
            logger,
            maxSkewMs: 600_000,
            reconciler: new SubscriptionReconciler({
                client: helix, logger, callbackUrl: 'https://x.test/eventsub/webhook',
                secret: SECRET, botUserId: 'bot-1'
            }),
            dryRunSubscriptions: dryRun
        });
    };

    beforeEach(() => {
        transport = build(false);
    });

    describe('lifecycle', () => {
        it('is idempotent on start', async () => {
            const first = vi.fn(async () => undefined);
            const second = vi.fn(async () => undefined);
            await transport.start(first);
            await transport.start(second);

            const app = createApp({ logger, version: 't', rawBodyRouters: [transport.router] });
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1', text: 'x' });
            await request(app).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body).expect(204);
            await transport.drain();

            // A second start must not silently replace the live handler.
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).not.toHaveBeenCalled();
        });

        it('is safe to stop without starting', async () => {
            await expect(transport.stop()).resolves.toBeUndefined();
        });

        it('drains before detaching the handler', async () => {
            const seen: TransportEvent[] = [];
            await transport.start(async (event) => {
                await new Promise((r) => setTimeout(r, 5));
                seen.push(event);
            });

            const app = createApp({ logger, version: 't', rawBodyRouters: [transport.router] });
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1', text: 'x' });
            await request(app).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body).expect(204);

            await transport.stop();

            // An acknowledged event must still be processed on the way down.
            expect(seen).toHaveLength(1);
        });
    });

    describe('subscription intent', () => {
        it('records a broadcaster and reconciles', async () => {
            await transport.subscribe('1001');

            expect(transport.subscribedBroadcasters).toEqual(['1001']);
            expect(helix.created.length).toBeGreaterThan(0);
        });

        it('ignores a repeat subscribe', async () => {
            await transport.subscribe('1001');
            const afterFirst = helix.created.length;
            await transport.subscribe('1001');

            // Reconciliation is convergent, so a repeat creates nothing new.
            expect(helix.created.length).toBe(afterFirst);
        });

        it('removes the subscriptions on unsubscribe', async () => {
            await transport.subscribe('1001');
            await transport.unsubscribe('1001');

            expect(transport.subscribedBroadcasters).toEqual([]);
            expect(helix.deleted.length).toBeGreaterThan(0);
        });

        it('ignores unsubscribing something never subscribed', async () => {
            await transport.unsubscribe('9999');

            expect(helix.deleted).toHaveLength(0);
        });

        it('changes nothing in dry-run mode', async () => {
            const dry = build(true);

            await dry.subscribe('1001');

            expect(dry.subscribedBroadcasters).toEqual(['1001']);
            expect(helix.created).toHaveLength(0);
        });

        it('does not fail a subscribe when reconciliation throws', async () => {
            // Reconciliation converges on the next run; it must never be able to
            // stop a channel from registering.
            const failing = new EventSubWebhookTransport({
                secret: SECRET, logger, maxSkewMs: 600_000, dryRunSubscriptions: false,
                reconciler: {
                    reconcile: async () => { throw new Error('helix down'); }
                } as unknown as SubscriptionReconciler
            });

            await expect(failing.subscribe('1001')).resolves.toBeUndefined();
            expect(failing.subscribedBroadcasters).toEqual(['1001']);
        });

        it('skips the per-subscribe reconcile when auto-reconcile is off', async () => {
            // Boot registers N channels in a loop; N list-and-diff round trips
            // produce what the single final pass produces anyway.
            transport.setAutoReconcile(false);

            await transport.subscribe('1001');
            await transport.subscribe('2002');

            expect(helix.created).toHaveLength(0);
            expect(transport.subscribedBroadcasters.sort()).toEqual(['1001', '2002']);

            // The explicit call still reconciles, and covers both at once.
            await transport.reconcile();
            expect(helix.created.map((c) => c.condition['broadcaster_user_id']))
                .toEqual(expect.arrayContaining(['1001', '2002']));
        });

        it('reconciles again once auto-reconcile is restored', async () => {
            // A channel onboarding at runtime must not wait for a restart.
            transport.setAutoReconcile(false);
            await transport.subscribe('1001');
            transport.setAutoReconcile(true);

            await transport.subscribe('2002');

            expect(helix.created.length).toBeGreaterThan(0);
        });

        it('works with no reconciler at all', async () => {
            const bare = new EventSubWebhookTransport({ secret: SECRET, logger, maxSkewMs: 600_000 });

            await expect(bare.subscribe('1001')).resolves.toBeUndefined();
            expect(bare.subscribedBroadcasters).toEqual(['1001']);
        });
    });

    describe('events arriving before start', () => {
        it('does not crash when an event is dequeued with no handler', async () => {
            const app = createApp({ logger, version: 't', rawBodyRouters: [transport.router] });
            const delivery = chatMessageDelivery(SECRET, { broadcasterUserId: '1', text: 'x' });

            await request(app).post(EVENTSUB_WEBHOOK_PATH).set(delivery.headers).send(delivery.body).expect(204);
            await transport.drain();

            expect(transport.stats.failed).toBe(0);
        });
    });
});

/**
 * The background convergence pass.
 *
 * The hole this closes, stated once: reconciliation is otherwise event-driven,
 * and `reconcile()` isolates per-subscription failures rather than throwing. So
 * a channel registered while Twitch is refusing creates ends up with a running
 * session and no subscriptions, on and silent, with nothing to retry it until
 * the next membership change or a restart. The desktop master switch makes that
 * reachable by the broadcaster at will, which is why the retry is a scheduled
 * task rather than an event-driven one.
 */
describe('periodic subscription reconciliation', () => {
    const INTERVAL = 60_000;

    const build = (intervalMs: number, sink?: string[]): {
        transport: EventSubWebhookTransport;
        helix: FakeHelixClient;
    } => {
        const helix = new FakeHelixClient();
        const log = sink
            ? pino({ level: 'info' }, { write: (line: string) => { sink.push(JSON.parse(line).msg as string); } })
            : logger;

        return {
            helix,
            transport: new EventSubWebhookTransport({
                secret: SECRET,
                logger: log,
                maxSkewMs: 600_000,
                reconciler: new SubscriptionReconciler({
                    client: helix, logger: log, callbackUrl: 'https://x.test/eventsub/webhook',
                    secret: SECRET, botUserId: 'bot-1'
                }),
                dryRunSubscriptions: false,
                reconcileIntervalMs: intervalMs
            })
        };
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('heals a channel that was enabled while every create failed', async () => {
        const { transport, helix } = build(INTERVAL);
        await transport.start(async () => undefined);

        // Twitch refuses all four creates - a rate limit, or a transient 5xx.
        helix.failCreate = 4;
        await transport.subscribe('1001');

        // The damage: the transport believes it wants this broadcaster, the
        // session is running, and Twitch has nothing to deliver against.
        expect(transport.subscribedBroadcasters).toEqual(['1001']);
        expect(await helix.listEventSubSubscriptions()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(INTERVAL);

        const live = await helix.listEventSubSubscriptions();
        expect(live).toHaveLength(4);
        expect(live.every((s) => s.condition['broadcaster_user_id'] === '1001')).toBe(true);

        await transport.stop();
    });

    it('keeps converging across ticks when failures persist', async () => {
        const { transport, helix } = build(INTERVAL);
        await transport.start(async () => undefined);

        // Enough failures to survive the subscribe AND the first tick.
        helix.failCreate = 8;
        await transport.subscribe('1001');

        await vi.advanceTimersByTimeAsync(INTERVAL);
        expect(await helix.listEventSubSubscriptions()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(INTERVAL);
        expect(await helix.listEventSubSubscriptions()).toHaveLength(4);

        await transport.stop();
    });

    it('says nothing on a tick that changed nothing', async () => {
        const lines: string[] = [];
        const { transport } = build(INTERVAL, lines);
        await transport.start(async () => undefined);
        await transport.subscribe('1001');

        lines.length = 0;
        await vi.advanceTimersByTimeAsync(INTERVAL * 3);

        // Three quiet ticks. A summary line every interval would be ~96 a day
        // and would train a reader to skip the line that reports real drift.
        expect(lines).toEqual([]);

        await transport.stop();
    });

    it('does speak up when a tick finds drift', async () => {
        const lines: string[] = [];
        const { transport, helix } = build(INTERVAL, lines);
        await transport.start(async () => undefined);

        helix.failCreate = 4;
        await transport.subscribe('1001');
        lines.length = 0;

        await vi.advanceTimersByTimeAsync(INTERVAL);

        expect(lines).toContain('EventSub subscription reconciliation');
        expect(lines).toContain('Created subscription');

        await transport.stop();
    });

    it('stops ticking once the transport stops', async () => {
        const { transport, helix } = build(INTERVAL);
        await transport.start(async () => undefined);
        helix.failCreate = 4;
        await transport.subscribe('1001');

        await transport.stop();
        await vi.advanceTimersByTimeAsync(INTERVAL * 5);

        // A timer outliving its transport would reconcile for a server that is
        // no longer serving anything.
        expect(await helix.listEventSubSubscriptions()).toHaveLength(0);
    });

    it('is off when the interval is zero', async () => {
        const { transport, helix } = build(0);
        await transport.start(async () => undefined);
        helix.failCreate = 4;
        await transport.subscribe('1001');

        await vi.advanceTimersByTimeAsync(60_000 * 60);

        expect(await helix.listEventSubSubscriptions()).toHaveLength(0);
        await transport.stop();
    });
});
