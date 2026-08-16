import type { Router } from 'express';
import type { TransportEvent } from '@almosthadai/shared';
import type { Logger } from '../../logger.js';
import type { Transport, EventHandler } from '../types.js';
import { createEventSubRouter, EVENTSUB_WEBHOOK_PATH } from './webhook.js';
import { IngestQueue } from './ingestQueue.js';
import type { EventSubSubscriptionInfo } from './messages.js';
import type { SubscriptionReconciler } from './subscriptionReconciler.js';

export interface WebhookTransportOptions {
    secret: string;
    logger: Logger;
    maxSkewMs: number;
    /** Absent until P1-WP6 supplies tokens; without it, subscriptions are never touched. */
    reconciler?: SubscriptionReconciler;
    /** True until a real Helix client exists: compute and log the diff, change nothing. */
    dryRunSubscriptions?: boolean;
    onRevocation?: (subscription: EventSubSubscriptionInfo) => void;
    maxQueueDepth?: number;
    /**
     * How often to reconcile subscriptions in the background. 0 disables it.
     *
     * Reconciliation is otherwise event-driven — it runs when a channel is
     * registered or removed — which leaves a real hole: if the creates fail
     * (Twitch rate limit, a transient 5xx), `reconcile()` isolates the failure
     * per subscription and carries on, so the channel ends up enabled, with a
     * running session, and no subscriptions. The bot looks on and answers
     * nothing, and nothing retries until the next membership change or a
     * restart. Since the desktop master switch made that path reachable by the
     * broadcaster at will, "someday" stopped being an acceptable answer.
     *
     * It also converges drift nobody triggered: a revocation we missed, a
     * subscription deleted by hand in the Twitch console.
     */
    reconcileIntervalMs?: number;
}

/**
 * The production transport: an HTTP endpoint plus the queue that drains it.
 *
 * `subscribe`/`unsubscribe` record intent rather than calling Twitch inline.
 * The desired set is then reconciled as a whole — one diff instead of N
 * imperative calls, which is what makes a restart, a crash mid-onboarding, and a
 * manual change in the Twitch console all converge to the same place.
 */
export class EventSubWebhookTransport implements Transport {
    readonly name = 'eventsub-webhook';
    readonly router: Router;

    private readonly logger: Logger;
    private readonly queue: IngestQueue<TransportEvent>;
    private readonly reconciler: SubscriptionReconciler | undefined;
    private readonly dryRunSubscriptions: boolean;

    private readonly broadcasterIds = new Set<string>();
    private handler: EventHandler | null = null;
    private started = false;
    private autoReconcile = true;

    private readonly reconcileIntervalMs: number;
    private reconcileTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: WebhookTransportOptions) {
        this.logger = options.logger;
        this.reconciler = options.reconciler;
        this.dryRunSubscriptions = options.dryRunSubscriptions ?? true;
        this.reconcileIntervalMs = options.reconcileIntervalMs ?? 0;

        this.queue = new IngestQueue<TransportEvent>({
            logger: options.logger,
            ...(options.maxQueueDepth === undefined ? {} : { maxDepth: options.maxQueueDepth }),
            worker: async (event) => {
                if (!this.handler) {
                    this.logger.warn({ kind: event.kind }, 'Event dequeued before the transport was started');
                    return;
                }
                await this.handler(event);
            }
        });

        this.router = createEventSubRouter({
            secret: options.secret,
            logger: options.logger,
            maxSkewMs: options.maxSkewMs,
            onEvent: (event) => this.queue.enqueue(event),
            onRevocation: options.onRevocation ?? (() => undefined)
        });
    }

    get queueDepth(): number {
        return this.queue.depth;
    }

    get stats(): { processed: number; failed: number; refused: number; depth: number } {
        return this.queue.stats;
    }

    get subscribedBroadcasters(): string[] {
        return [...this.broadcasterIds];
    }

    async start(handler: EventHandler): Promise<void> {
        if (this.started) return;
        this.handler = handler;
        this.started = true;
        this.startPeriodicReconcile();
        this.logger.info({ path: EVENTSUB_WEBHOOK_PATH }, 'EventSub webhook transport started');
    }

    /** Drains before detaching: an acknowledged event must still be processed. */
    async stop(): Promise<void> {
        if (!this.started) return;
        this.stopPeriodicReconcile();
        await this.queue.close();
        this.handler = null;
        this.started = false;
        this.logger.info('EventSub webhook transport stopped');
    }

    /**
     * The background convergence pass.
     *
     * Lives in the transport's own lifecycle so it cannot outlive the thing it
     * reconciles for, and is `unref`'d so a pending tick never holds the
     * process open during shutdown.
     */
    private startPeriodicReconcile(): void {
        if (this.reconcileIntervalMs <= 0 || !this.reconciler) return;

        this.reconcileTimer = setInterval(() => {
            // Deliberately not awaited: a tick that runs long must not stack up
            // behind the next one, and reconcile() already isolates its own
            // failures rather than throwing.
            void this.reconcile({ quietWhenUnchanged: true });
        }, this.reconcileIntervalMs);

        this.reconcileTimer.unref?.();
        this.logger.info(
            { intervalMs: this.reconcileIntervalMs },
            'Periodic subscription reconciliation scheduled'
        );
    }

    private stopPeriodicReconcile(): void {
        if (!this.reconcileTimer) return;
        clearInterval(this.reconcileTimer);
        this.reconcileTimer = null;
    }

    /**
     * Suppresses the per-subscribe reconciliation.
     *
     * Boot registers every channel in a loop, and reconciling inside that loop
     * would be N list-and-diff round trips to produce a result the single final
     * pass produces anyway. A channel onboarding at *runtime* still reconciles
     * immediately, which is why this is a toggle and not a removal.
     */
    setAutoReconcile(enabled: boolean): void {
        this.autoReconcile = enabled;
    }

    async subscribe(broadcasterTwitchId: string): Promise<void> {
        if (this.broadcasterIds.has(broadcasterTwitchId)) return;
        this.broadcasterIds.add(broadcasterTwitchId);
        if (this.autoReconcile) await this.reconcile();
    }

    async unsubscribe(broadcasterTwitchId: string): Promise<void> {
        if (!this.broadcasterIds.delete(broadcasterTwitchId)) return;
        if (this.autoReconcile) await this.reconcile();
    }

    /** Always reconciles, regardless of the toggle: boot calls this once at the end. */
    async reconcile(options: { quietWhenUnchanged?: boolean } = {}): Promise<void> {
        if (!this.reconciler) return;

        try {
            await this.reconciler.reconcile(
                [...this.broadcasterIds],
                this.dryRunSubscriptions,
                options
            );
        } catch (err) {
            // Reconciliation is convergent: a failure now is retried by the next
            // run, so it must never propagate into channel registration.
            this.logger.error({ err: (err as Error).message }, 'Subscription reconciliation failed');
        }
    }

    /** Waits for the queue to empty. Used by shutdown and by end-to-end tests. */
    async drain(): Promise<void> {
        await this.queue.drain();
    }
}
