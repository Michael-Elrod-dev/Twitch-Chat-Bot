import type { Logger } from '../../logger.js';
import type { EventSubSubscriptionInfo } from './messages.js';
import type { ChannelRepository } from '../../db/repositories/channelRepository.js';
import type { SubscriptionReconciler } from './subscriptionReconciler.js';

/**
 * What to do when Twitch revokes a subscription.
 *
 * Revocation is per subscription, not per channel. Losing `stream.online` while
 * chat still works is a degraded channel, not a disconnected one, and marking
 * the whole tenant dead for it would take a working bot offline.
 *
 * Recovery is one delayed attempt, never a loop. Twitch's revocation reasons are
 * mostly terminal, since `authorization_revoked` and `user_removed` cannot be
 * fixed by asking again, so retrying hard would be noise that hides the one case
 * (`notification_failures_exceeded`, after an outage on this side) that
 * genuinely recovers.
 */

/** Long enough that a transient outage has passed, short enough to matter. */
const RETRY_DELAY_MS = 30_000;

/** Reasons no amount of retrying will fix: only the user can. */
const TERMINAL_STATUSES = new Set(['authorization_revoked', 'user_removed', 'version_removed']);

export interface RevocationRecoveryOptions {
    logger: Logger;
    channels: ChannelRepository;
    reconciler: SubscriptionReconciler;
    /** The broadcasters currently running, so recovery can rebuild the desired set. */
    activeBroadcasterIds: () => string[];
    retryDelayMs?: number;
    /** Injectable so tests do not wait 30 seconds. */
    schedule?: (fn: () => void, ms: number) => void;
}

export class RevocationRecovery {
    private readonly options: RevocationRecoveryOptions;
    private readonly retryDelayMs: number;
    private readonly schedule: (fn: () => void, ms: number) => void;

    /** Subscriptions already being retried, so duplicates do not stack attempts. */
    private readonly pending = new Set<string>();

    constructor(options: RevocationRecoveryOptions) {
        this.options = options;
        this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
        this.schedule = options.schedule ?? ((fn, ms) => {
            const timer = setTimeout(fn, ms);
            // Never hold the process open for a retry.
            timer.unref?.();
        });
    }

    /** Called from the webhook's revocation handler. Returns immediately. */
    handle(subscription: EventSubSubscriptionInfo): void {
        const broadcasterId = subscription.condition['broadcaster_user_id'] ?? '';
        const key = `${subscription.type}:${broadcasterId}`;

        this.options.logger.error(
            {
                subscriptionId: subscription.id,
                subscriptionType: subscription.type,
                status: subscription.status,
                broadcasterId
            },
            'EventSub subscription revoked by Twitch'
        );

        if (TERMINAL_STATUSES.has(subscription.status)) {
            // Straight to needs-reauth: retrying an authorization the user
            // withdrew would fail identically every time.
            void this.markNeedsReauth(broadcasterId, subscription.type, subscription.status);
            return;
        }

        if (this.pending.has(key)) {
            this.options.logger.debug({ key }, 'Revocation retry already scheduled');
            return;
        }
        this.pending.add(key);

        this.schedule(() => {
            void this.attemptRecovery(key, broadcasterId, subscription);
        }, this.retryDelayMs);
    }

    private async attemptRecovery(
        key: string,
        broadcasterId: string,
        subscription: EventSubSubscriptionInfo
    ): Promise<void> {
        this.pending.delete(key);

        try {
            // Reconciliation, not a targeted create: the desired set is already
            // computed correctly, and a revoked subscription is simply missing
            // from the actual set.
            const result = await this.options.reconciler.reconcile(this.options.activeBroadcasterIds(), false);

            if (result.failures > 0) {
                await this.markNeedsReauth(broadcasterId, subscription.type, 'resubscribe_failed');
                return;
            }

            this.options.logger.info(
                { subscriptionType: subscription.type, broadcasterId, created: result.created },
                'Resubscribed after revocation'
            );
        } catch (err) {
            this.options.logger.error(
                { subscriptionType: subscription.type, broadcasterId, err: (err as Error).message },
                'Resubscribe attempt failed'
            );
            await this.markNeedsReauth(broadcasterId, subscription.type, 'resubscribe_failed');
        }
    }

    private async markNeedsReauth(broadcasterId: string, subscriptionType: string, reason: string): Promise<void> {
        if (broadcasterId === '') return;

        try {
            const channel = await this.options.channels.findByBroadcasterId(broadcasterId);
            if (!channel) return;

            await this.options.channels.setStatus(channel.id, 'needs_reauth');

            // Error level and named: this state only clears when a human
            // re-authorizes, so it must be impossible to miss in the logs.
            this.options.logger.error(
                { channelId: channel.id, login: channel.twitchLogin, subscriptionType, reason },
                'CHANNEL NEEDS RE-AUTHORIZATION - the broadcaster must reconnect via /auth/twitch/connect'
            );
        } catch (err) {
            this.options.logger.error(
                { broadcasterId, err: (err as Error).message },
                'Could not mark channel as needing re-authorization'
            );
        }
    }
}
