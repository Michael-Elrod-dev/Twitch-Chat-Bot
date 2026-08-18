import { describe, it, expect, beforeEach } from 'vitest';
import { pino } from 'pino';
import { SubscriptionReconciler, DESIRED_SUBSCRIPTIONS } from './subscriptionReconciler.js';
import { FakeHelixClient, type EventSubSubscription } from './helixClient.js';
import { SUBSCRIPTION_TYPES } from './messages.js';

const logger = pino({ level: 'silent' });
const BOT_ID = 'bot-999';
const CALLBACK = 'https://bot.example.duckdns.org/eventsub/webhook';
const SECRET = 'reconciler-test-secret';

const chatSub = (broadcasterId: string, status = 'enabled'): Omit<EventSubSubscription, 'id'> => ({
    type: SUBSCRIPTION_TYPES.chatMessage,
    version: '1',
    status,
    condition: { broadcaster_user_id: broadcasterId, user_id: BOT_ID }
});

const onlineSub = (broadcasterId: string, status = 'enabled'): Omit<EventSubSubscription, 'id'> => ({
    type: SUBSCRIPTION_TYPES.streamOnline,
    version: '1',
    status,
    condition: { broadcaster_user_id: broadcasterId }
});

const offlineSub = (broadcasterId: string, status = 'enabled'): Omit<EventSubSubscription, 'id'> => ({
    type: SUBSCRIPTION_TYPES.streamOffline,
    version: '1',
    status,
    condition: { broadcaster_user_id: broadcasterId }
});

/**
 * Joined DESIRED_SUBSCRIPTIONS in P1-WP4.2, alongside its handler.
 *
 * **The `reward_id: ''` is not decoration — it is what Twitch actually returns.**
 * We create this subscription with `{broadcaster_user_id}` alone and Twitch
 * echoes the optional field back as an empty string. This fixture used to omit
 * it, which is precisely why the reconciler shipped unable to recognize its own
 * redemption subscription: every test agreed with the code and neither agreed
 * with Twitch. A fixture that does not match the wire proves nothing.
 */
const redemptionSub = (broadcasterId: string, status = 'enabled'): Omit<EventSubSubscription, 'id'> => ({
    type: SUBSCRIPTION_TYPES.redemptionAdd,
    version: '1',
    status,
    condition: { broadcaster_user_id: broadcasterId, reward_id: '' }
});

describe('SubscriptionReconciler', () => {
    let client: FakeHelixClient;
    let reconciler: SubscriptionReconciler;

    beforeEach(() => {
        client = new FakeHelixClient();
        reconciler = new SubscriptionReconciler({
            client, logger, callbackUrl: CALLBACK, secret: SECRET, botUserId: BOT_ID
        });
    });

    describe('the diff', () => {
        it('creates every desired subscription for a channel with none', () => {
            const plan = reconciler.plan(['1001'], []);

            expect(plan.create).toHaveLength(DESIRED_SUBSCRIPTIONS.length);
            expect(plan.create.map((c) => c.type).sort()).toEqual(
                DESIRED_SUBSCRIPTIONS.map((d) => d.type).sort()
            );
            expect(plan.remove).toHaveLength(0);
        });

        it('creates nothing when everything already exists', () => {
            const actual = [chatSub('1001'), onlineSub('1001'), offlineSub('1001'), redemptionSub('1001')]
                .map((s) => client.seed(s));

            const plan = reconciler.plan(['1001'], actual);

            expect(plan.create).toHaveLength(0);
            expect(plan.remove).toHaveLength(0);
            expect(plan.keep).toHaveLength(DESIRED_SUBSCRIPTIONS.length);
        });

        it('recognizes its own subscription when Twitch echoes an empty optional field', () => {
            /*
             * The production defect, as a test.
             *
             * Found in the logs within an hour of periodic reconciliation going
             * live: `create:1 remove:1 keep:3`, every fifteen minutes, forever.
             * The reconciler was deleting and recreating the redemption
             * subscription on every run because Twitch's echoed
             * `reward_id: ''` made it hash differently from the desired one.
             *
             * The cost was not just churn. Between the delete and the create
             * there is a window in which a viewer's redemption is never
             * delivered - points spent, nothing given back, which is the exact
             * failure the redemption pipeline exists to prevent.
             */
            const asTwitchReturnsIt = client.seed(redemptionSub('1001'));

            const plan = reconciler.plan(['1001'], [asTwitchReturnsIt]);

            expect(plan.remove).toHaveLength(0);
            expect(plan.keep).toContainEqual(asTwitchReturnsIt);
            expect(plan.create.map((c) => c.type))
                .not.toContain(SUBSCRIPTION_TYPES.redemptionAdd);
        });

        it('removes subscriptions for a channel that is no longer active', () => {
            const orphan = client.seed(chatSub('9999'));

            const plan = reconciler.plan(['1001'], [orphan]);

            expect(plan.remove).toEqual([{ subscription: orphan, reason: 'orphaned' }]);
        });

        it('replaces an unhealthy subscription rather than leaving it in place', () => {
            // A revoked subscription occupies the slot while delivering nothing,
            // which is worse than not having one at all.
            const dead = client.seed(chatSub('1001', 'authorization_revoked'));

            const plan = reconciler.plan(['1001'], [dead]);

            expect(plan.remove).toEqual([{ subscription: dead, reason: 'unhealthy' }]);
            expect(plan.create.map((c) => c.type)).toContain(SUBSCRIPTION_TYPES.chatMessage);
        });

        it('treats a pending verification as healthy', () => {
            // Recreating one that is merely awaiting its challenge would loop.
            const pending = client.seed(chatSub('1001', 'webhook_callback_verification_pending'));

            const plan = reconciler.plan(['1001'], [pending]);

            expect(plan.remove).toHaveLength(0);
            expect(plan.keep).toContain(pending);
        });

        it('removes a duplicate of something already satisfied', () => {
            const first = client.seed(chatSub('1001'));
            const second = client.seed(chatSub('1001'));

            const plan = reconciler.plan(['1001'], [first, second]);

            expect(plan.remove).toHaveLength(1);
            expect(plan.keep).toHaveLength(1);
        });

        it('does not match a subscription whose condition names a different bot', () => {
            // The bot's own user id is part of what makes a chat subscription
            // the right one; a stale bot account must not look satisfied.
            const stale = client.seed({
                type: SUBSCRIPTION_TYPES.chatMessage,
                version: '1',
                status: 'enabled',
                condition: { broadcaster_user_id: '1001', user_id: 'old-bot' }
            });

            const plan = reconciler.plan(['1001'], [stale]);

            expect(plan.remove).toEqual([{ subscription: stale, reason: 'orphaned' }]);
            expect(plan.create.map((c) => c.type)).toContain(SUBSCRIPTION_TYPES.chatMessage);
        });

        it('does not match a different version of the same type', () => {
            const v2 = client.seed({ ...chatSub('1001'), version: '2' });

            expect(reconciler.plan(['1001'], [v2]).remove).toHaveLength(1);
        });

        it('ignores condition key order', () => {
            const reordered = client.seed({
                type: SUBSCRIPTION_TYPES.chatMessage,
                version: '1',
                status: 'enabled',
                condition: { user_id: BOT_ID, broadcaster_user_id: '1001' }
            });

            expect(reconciler.plan(['1001'], [reordered]).remove).toHaveLength(0);
        });

        it('handles many channels at once and deduplicates the input list', () => {
            const plan = reconciler.plan(['1001', '2002', '1001'], []);

            expect(plan.create).toHaveLength(2 * DESIRED_SUBSCRIPTIONS.length);
        });

        it('removes everything when no channel is active', () => {
            const existing = [chatSub('1001'), onlineSub('1001')].map((s) => client.seed(s));

            const plan = reconciler.plan([], existing);

            expect(plan.remove).toHaveLength(2);
            expect(plan.create).toHaveLength(0);
        });

        it('carries the callback and secret into every create', () => {
            const plan = reconciler.plan(['1001'], []);

            for (const input of plan.create) {
                expect(input.transport).toEqual({ method: 'webhook', callback: CALLBACK, secret: SECRET });
            }
        });

        it('names the bot in the chat condition and only there', () => {
            const plan = reconciler.plan(['1001'], []);
            const chat = plan.create.find((c) => c.type === SUBSCRIPTION_TYPES.chatMessage);
            const online = plan.create.find((c) => c.type === SUBSCRIPTION_TYPES.streamOnline);

            expect(chat?.condition).toEqual({ broadcaster_user_id: '1001', user_id: BOT_ID });
            expect(online?.condition).toEqual({ broadcaster_user_id: '1001' });
        });
    });

    describe('applying the plan', () => {
        it('creates the missing subscriptions', async () => {
            const result = await reconciler.reconcile(['1001']);

            expect(result.created).toBe(DESIRED_SUBSCRIPTIONS.length);
            expect(client.created).toHaveLength(DESIRED_SUBSCRIPTIONS.length);
        });

        it('converges: a second run changes nothing', async () => {
            // The property that makes reconciliation worth the machinery.
            await reconciler.reconcile(['1001']);
            const second = await reconciler.reconcile(['1001']);

            expect(second.created).toBe(0);
            expect(second.removed).toBe(0);
        });

        it('deletes orphans', async () => {
            const orphan = client.seed(chatSub('9999'));

            const result = await reconciler.reconcile(['1001']);

            expect(result.removed).toBe(1);
            expect(client.deleted).toContain(orphan.id);
        });

        it('removes before it creates, so a slot is freed first', async () => {
            const dead = client.seed(chatSub('1001', 'notification_failures_exceeded'));

            await reconciler.reconcile(['1001']);

            expect(client.deleted).toContain(dead.id);
            expect(client.created.map((c) => c.type)).toContain(SUBSCRIPTION_TYPES.chatMessage);
        });

        it('continues past a failed create and reports it', async () => {
            // One failure must not abandon the rest; the next run retries it.
            client.failCreate = 1;

            const result = await reconciler.reconcile(['1001']);

            expect(result.failures).toBe(1);
            expect(result.created).toBe(DESIRED_SUBSCRIPTIONS.length - 1);
        });

        it('continues past a failed delete', async () => {
            client.seed(chatSub('9999'));
            client.failDelete = 1;

            const result = await reconciler.reconcile(['1001']);

            expect(result.failures).toBe(1);
            expect(result.created).toBe(DESIRED_SUBSCRIPTIONS.length);
        });
    });

    describe('dry run', () => {
        it('computes the plan without touching Twitch', async () => {
            client.seed(chatSub('9999'));

            const result = await reconciler.reconcile(['1001'], true);

            expect(result.dryRun).toBe(true);
            expect(result.create).toHaveLength(DESIRED_SUBSCRIPTIONS.length);
            expect(result.remove).toHaveLength(1);
            // Nothing was actually done - this is how it runs until P1-WP6.
            expect(client.created).toHaveLength(0);
            expect(client.deleted).toHaveLength(0);
        });
    });
});
