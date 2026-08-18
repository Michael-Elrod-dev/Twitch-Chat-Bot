import type { Logger } from '../../logger.js';
import { SUBSCRIPTION_TYPES } from './messages.js';
import type {
    CreateSubscriptionInput,
    EventSubCondition,
    EventSubSubscription,
    HelixClient
} from './helixClient.js';

/**
 * Subscription state is reconciled, not commanded.
 *
 * "Create a subscription when a channel onboards" is a script that drifts the
 * moment anything is created out of band, a delivery fails permanently, or a
 * channel leaves while the process is down. Computing the desired set and
 * diffing it against the actual set converges from any starting state,
 * including one nobody planned for.
 */

/** Statuses that count as a working subscription. Everything else is replaced. */
const HEALTHY_STATUSES = new Set(['enabled', 'webhook_callback_verification_pending']);

export interface DesiredSubscriptionType {
    type: string;
    version: string;
    /** Builds the condition for one broadcaster. */
    condition: (broadcasterTwitchId: string, botUserId: string) => EventSubCondition;
}

/**
 * What the server needs to hear.
 *
 * `channel.chat.message` names the reading user as well as the broadcaster.
 * That second field is the bot's own id, which is what makes one shared bot
 * account work across every channel (docs/TWITCH_PLATFORM_FACTS.md section 2).
 *
 * Subscribe when a consumer exists, never before. The worst shape of failure
 * available here is a viewer spending channel points, Twitch recording a
 * successful delivery, and nothing happening with no trace anywhere, which is
 * exactly what subscribing ahead of a handler produces. An acknowledged event
 * is a delivered event as far as Twitch is concerned, so revocation never
 * catches this. Only the silent drop does.
 *
 * A subscription is added here alongside the handler that consumes it, and the
 * reconciler then converges on the next boot with no migration and no manual
 * step. `channel.follow` has no consumer yet, so it is absent.
 */
export const DESIRED_SUBSCRIPTIONS: DesiredSubscriptionType[] = [
    {
        type: SUBSCRIPTION_TYPES.chatMessage,
        version: '1',
        condition: (broadcasterTwitchId, botUserId) => ({
            broadcaster_user_id: broadcasterTwitchId,
            user_id: botUserId
        })
    },
    {
        type: SUBSCRIPTION_TYPES.streamOnline,
        version: '1',
        condition: (broadcasterTwitchId) => ({ broadcaster_user_id: broadcasterTwitchId })
    },
    {
        type: SUBSCRIPTION_TYPES.streamOffline,
        version: '1',
        condition: (broadcasterTwitchId) => ({ broadcaster_user_id: broadcasterTwitchId })
    },
    {
        // Needs `channel:read:redemptions` from the broadcaster, which the
        // onboarding consent already collects.
        type: SUBSCRIPTION_TYPES.redemptionAdd,
        version: '1',
        condition: (broadcasterTwitchId) => ({ broadcaster_user_id: broadcasterTwitchId })
    }
];

export interface ReconcilerOptions {
    client: HelixClient;
    logger: Logger;
    callbackUrl: string;
    secret: string;
    /**
     * A getter, not a value, because the bot account can change at runtime when
     * consent is re-granted. The chat subscription's condition names it, so a
     * stale id here would diff every subscription as an orphan.
     */
    botUserId: string | (() => string);
    desired?: DesiredSubscriptionType[];
}

export interface ReconcilePlan {
    create: CreateSubscriptionInput[];
    /** Subscriptions to remove, with the reason, so the log explains itself. */
    remove: { subscription: EventSubSubscription; reason: 'orphaned' | 'unhealthy' }[];
    keep: EventSubSubscription[];
}

export interface ReconcileResult extends ReconcilePlan {
    created: number;
    removed: number;
    failures: number;
    dryRun: boolean;
}

export class SubscriptionReconciler {
    private readonly options: ReconcilerOptions;

    constructor(options: ReconcilerOptions) {
        this.options = options;
    }

    /** Pure: computes the diff without touching Twitch. Exposed so it can be tested and logged. */
    plan(broadcasterIds: string[], actual: EventSubSubscription[]): ReconcilePlan {
        const { callbackUrl, secret, desired = DESIRED_SUBSCRIPTIONS } = this.options;
        const botUserId = typeof this.options.botUserId === 'function'
            ? this.options.botUserId()
            : this.options.botUserId;

        const wanted = new Map<string, CreateSubscriptionInput>();
        for (const broadcasterTwitchId of new Set(broadcasterIds)) {
            for (const spec of desired) {
                const condition = spec.condition(broadcasterTwitchId, botUserId);
                wanted.set(identity(spec.type, spec.version, condition), {
                    type: spec.type,
                    version: spec.version,
                    condition,
                    transport: { method: 'webhook', callback: callbackUrl, secret }
                });
            }
        }

        const keep: EventSubSubscription[] = [];
        const remove: ReconcilePlan['remove'] = [];
        const satisfied = new Set<string>();

        for (const subscription of actual) {
            const key = identity(subscription.type, subscription.version, subscription.condition);

            if (!wanted.has(key)) {
                remove.push({ subscription, reason: 'orphaned' });
                continue;
            }

            // A failed or revoked subscription is worse than a missing one. It
            // occupies the slot while delivering nothing, so it is replaced.
            if (!HEALTHY_STATUSES.has(subscription.status)) {
                remove.push({ subscription, reason: 'unhealthy' });
                continue;
            }

            // A duplicate of something already satisfied is itself an orphan.
            if (satisfied.has(key)) {
                remove.push({ subscription, reason: 'orphaned' });
                continue;
            }

            satisfied.add(key);
            keep.push(subscription);
        }

        const create = [...wanted.entries()]
            .filter(([key]) => !satisfied.has(key))
            .map(([, input]) => input);

        return { create, remove, keep };
    }

    /**
     * Applies the plan.
     *
     * @param dryRun when true, the plan is computed and logged but nothing is
     * sent to Twitch. The diff stays visible in the logs, so the day it goes
     * live it executes a plan that has already been observed.
     */
    async reconcile(
        broadcasterIds: string[],
        dryRun = false,
        // The background pass runs on a timer whether or not anything has
        // drifted. Logging a summary every tick would write about 96 identical
        // lines a day and train anyone reading the logs to skip them, which is
        // exactly the wrong reflex for the line that reports drift.
        options: { quietWhenUnchanged?: boolean } = {}
    ): Promise<ReconcileResult> {
        const { client, logger } = this.options;

        const actual = await client.listEventSubSubscriptions();
        const plan = this.plan(broadcasterIds, actual);

        const unchanged = plan.create.length === 0 && plan.remove.length === 0;
        if (!(options.quietWhenUnchanged && unchanged)) {
            logger.info(
                {
                    dryRun,
                    broadcasters: new Set(broadcasterIds).size,
                    create: plan.create.length,
                    remove: plan.remove.length,
                    keep: plan.keep.length
                },
                'EventSub subscription reconciliation'
            );
        }

        if (dryRun) {
            for (const input of plan.create) {
                logger.info({ type: input.type, condition: input.condition }, 'Would create subscription');
            }
            for (const { subscription, reason } of plan.remove) {
                logger.info({ id: subscription.id, type: subscription.type, reason }, 'Would remove subscription');
            }
            return { ...plan, created: 0, removed: 0, failures: 0, dryRun: true };
        }

        let created = 0;
        let removed = 0;
        let failures = 0;

        // Removals first, so a slot occupied by a dead subscription is freed
        // before its replacement is requested.
        for (const { subscription, reason } of plan.remove) {
            try {
                await client.deleteEventSubSubscription(subscription.id);
                removed++;
                logger.info({ id: subscription.id, type: subscription.type, reason }, 'Removed subscription');
            } catch (err) {
                // One failure must not abandon the rest of the reconciliation.
                // The next run sees the same diff and tries again.
                failures++;
                logger.error({ id: subscription.id, err: (err as Error).message }, 'Failed to remove subscription');
            }
        }

        for (const input of plan.create) {
            try {
                await client.createEventSubSubscription(input);
                created++;
                logger.info({ type: input.type, condition: input.condition }, 'Created subscription');
            } catch (err) {
                failures++;
                logger.error({ type: input.type, err: (err as Error).message }, 'Failed to create subscription');
            }
        }

        return { ...plan, created, removed, failures, dryRun: false };
    }
}

/**
 * Type, version and condition together are what make two subscriptions the same
 * subscription.
 *
 * Empty condition values are dropped, not compared. Twitch echoes optional
 * condition fields back as empty strings, so the redemption subscription is
 * created with `{broadcaster_user_id}` and returned as
 * `{broadcaster_user_id, reward_id: ""}`. Comparing those key for key makes the
 * reconciler fail to recognize its own subscription, which then diffs as an
 * orphan, is deleted, and is recreated on every run. On a timer that is a
 * delete-and-recreate cycle every fifteen minutes, and the window between the
 * two calls is a window in which a viewer's redemption is never delivered.
 *
 * An unset condition field and an absent one are the same fact, so they must
 * produce the same identity.
 */
function identity(type: string, version: string, condition: EventSubCondition): string {
    const normalized = Object.keys(condition)
        .filter((key) => (condition[key] ?? '') !== '')
        .sort()
        .map((key) => `${key}=${condition[key] ?? ''}`)
        .join('&');
    return `${type}@${version}?${normalized}`;
}
