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

    constructor(options: WebhookTransportOptions) {
        this.logger = options.logger;
        this.reconciler = options.reconciler;
        this.dryRunSubscriptions = options.dryRunSubscriptions ?? true;

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
        this.logger.info({ path: EVENTSUB_WEBHOOK_PATH }, 'EventSub webhook transport started');
    }

    /** Drains before detaching: an acknowledged event must still be processed. */
    async stop(): Promise<void> {
        if (!this.started) return;
        await this.queue.close();
        this.handler = null;
        this.started = false;
        this.logger.info('EventSub webhook transport stopped');
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
    async reconcile(): Promise<void> {
        if (!this.reconciler) return;

        try {
            await this.reconciler.reconcile([...this.broadcasterIds], this.dryRunSubscriptions);
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
