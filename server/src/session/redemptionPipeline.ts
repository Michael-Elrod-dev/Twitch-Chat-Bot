import type { RedemptionEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { RedemptionSettlement } from '../services/redemptionSettlement.js';
import type { ChannelRewardRepository, RewardKind } from '../db/repositories/channelRewardRepository.js';
import type { AnalyticsSink } from '../services/analytics.js';
import type { ChatHistoryRepository } from '../db/repositories/chatHistoryRepository.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';

/**
 * What happens when a viewer spends channel points.
 *
 * The Phase-0 discipline ported whole: **every redemption ends fulfilled or
 * refunded, never neither.** A redemption left in its default `UNFULFILLED`
 * state has taken the viewer's points and given nothing back, and nobody
 * notices until they complain.
 *
 * Routing is by reward id. Phase 0 matched on the title string, so renaming a
 * reward in the Twitch dashboard silently broke it.
 */

export type RedemptionOutcome =
    | { action: 'fulfilled'; kind: RewardKind }
    | { action: 'refunded'; kind: RewardKind; reason: string }
    | { action: 'ignored'; reason: 'unmanaged_reward' | 'no_handler' };

export interface RedemptionHandlerContext {
    event: RedemptionEvent;
    channelId: string;
    reply: (message: string) => Promise<void>;
}

/**
 * @returns null on success, or a viewer-facing reason to refund.
 *
 * Returning a reason rather than throwing makes the refund path the ordinary
 * one: a handler that cannot do its job says so, and the pipeline gives the
 * points back with that message.
 */
export type RedemptionHandler = (context: RedemptionHandlerContext) => Promise<string | null>;

export interface RedemptionPipelineOptions {
    channelId: string;
    rewards: ChannelRewardRepository;
    settlement: RedemptionSettlement;
    handlers: Partial<Record<RewardKind, RedemptionHandler>>;
    logger: Logger;
    sendMessage: (text: string) => Promise<void>;
    /**
     * Where a fulfilled redemption is counted.
     *
     * Until this existed the redemption path wrote no analytics at all: the
     * dashboard's "points redeemed" tile read zero forever, and so did every
     * viewer's lifetime `redemption_count` — a column that has been in the
     * schema, and empty, the whole time. Omitted means nothing is counted,
     * which is what every existing caller without one gets.
     */
    analytics?: AnalyticsSink;
    /**
     * Chat persistence, so a redemption appears in the same table as chat with
     * the `redemption` message type the schema already has. Omitted means the
     * row is not written.
     */
    history?: ChatHistoryRepository;
    /**
     * Presence for the redeemer.
     *
     * Required before the history row: `chat_messages.twitch_user_id`
     * references `viewers` with RESTRICT, and someone can redeem a reward
     * without ever having typed in chat — so the path that records the
     * redemption cannot assume the chat path already created them.
     */
    roles?: ChannelRoleRepository;
    /** Buckets the redemption into the stream it happened in. */
    currentStreamId?: () => string | null;
}

export class RedemptionPipeline {
    private readonly options: RedemptionPipelineOptions;

    constructor(options: RedemptionPipelineOptions) {
        this.options = options;
    }

    async handle(event: RedemptionEvent): Promise<RedemptionOutcome> {
        const o = this.options;

        const managed = await o.rewards.findByRewardId(event.rewardId);
        if (!managed) {
            // Explicitly none of our business. The broadcaster's own rewards -
            // "Pick the game", "MS paint" - are theirs to fulfil by hand, and
            // touching their status would be taking over something we were
            // never asked to run.
            o.logger.debug(
                { channelId: o.channelId, rewardId: event.rewardId, title: event.rewardTitle },
                'Redemption for an unmanaged reward - leaving it alone'
            );
            return { action: 'ignored', reason: 'unmanaged_reward' };
        }

        const handler = o.handlers[managed.kind];
        if (!handler) {
            // Managed but unimplemented: refund rather than silently keep the
            // points. This is the state a half-finished deploy produces.
            o.logger.error(
                { channelId: o.channelId, kind: managed.kind },
                'No handler for a managed reward - refunding'
            );
            await this.refund(event, managed.kind, 'That reward is not available right now.');
            return { action: 'ignored', reason: 'no_handler' };
        }

        let failureReason: string | null;
        try {
            failureReason = await handler({
                event,
                channelId: o.channelId,
                reply: o.sendMessage
            });
        } catch (err) {
            // A handler that throws is a handler that did not deliver, which is
            // a refund - not an exception that leaves the points taken.
            o.logger.error(
                { channelId: o.channelId, kind: managed.kind, err: (err as Error).message },
                'Redemption handler threw - refunding'
            );
            failureReason = 'Something went wrong. Your points have been refunded.';
        }

        if (failureReason !== null) {
            await this.refund(event, managed.kind, failureReason);
            return { action: 'refunded', kind: managed.kind, reason: failureReason };
        }

        await this.fulfil(event, managed.kind);
        return { action: 'fulfilled', kind: managed.kind };
    }

    /**
     * Counts a redemption the bot actually delivered.
     *
     * **Fulfilled only, and managed rewards only.** A refund hands the points
     * back, so counting one as "points redeemed" would report a spend that did
     * not stick; and an unmanaged reward is the broadcaster's own — the pipeline
     * deliberately leaves those alone, so claiming them on the bot's dashboard
     * would attribute someone else's reward economy to us.
     *
     * Best-effort throughout, like every other bookkeeping write on a live path:
     * the viewer has already been served, and losing a counter is not a reason
     * to turn a successful redemption into a failed one.
     */
    private async recordAnalytics(event: RedemptionEvent): Promise<void> {
        const o = this.options;

        try {
            // Presence first — always, not only when history is configured.
            // The viewers row is what the history insert's FK needs, and a
            // redeemer who has never chatted does not have one yet.
            await o.roles?.touchPresence(event.redeemer.twitchUserId, event.redeemer.login);

            await o.history?.record({
                twitchUserId: event.redeemer.twitchUserId,
                // What the viewer typed into the reward, which for a song
                // request is the track. Empty for rewards that take no input.
                content: event.userInput,
                messageType: 'redemption',
                streamId: o.currentStreamId?.() ?? null
            });

            await o.analytics?.recordInteraction(
                o.channelId,
                {
                    messageId: event.messageId,
                    chatter: { twitchUserId: event.redeemer.twitchUserId }
                },
                'redemption'
            );
        } catch (err) {
            o.logger.warn(
                { channelId: o.channelId, err: (err as Error).message },
                'Could not record redemption analytics'
            );
        }
    }

    private async fulfil(event: RedemptionEvent, kind: RewardKind): Promise<void> {
        const o = this.options;

        await this.recordAnalytics(event);

        try {
            await o.settlement.settle(event, 'FULFILLED');
            o.logger.info({ channelId: o.channelId, kind }, 'Redemption fulfilled');
        } catch (err) {
            // Loud, but not fatal: the viewer got what they paid for, and the
            // status is cosmetic by comparison. The reverse is not true, which
            // is why the refund path retries and this one does not.
            o.logger.error(
                { channelId: o.channelId, kind, err: (err as Error).message },
                'Could not mark redemption fulfilled - the viewer WAS served'
            );
        }
    }

    private async refund(event: RedemptionEvent, kind: RewardKind, reason: string): Promise<void> {
        const o = this.options;

        try {
            await o.settlement.settle(event, 'CANCELED');
            o.logger.info({ channelId: o.channelId, kind, reason }, 'Redemption refunded');
        } catch (err) {
            // The worst outcome available: the viewer paid, got nothing, and
            // the points were not returned. It must be impossible to miss.
            o.logger.error(
                {
                    channelId: o.channelId,
                    kind,
                    redemptionId: event.redemptionId,
                    redeemer: event.redeemer.login,
                    err: (err as Error).message
                },
                'REFUND FAILED - the viewer has lost channel points and needs a manual refund'
            );
        }

        // Told either way. A silent refund looks like the reward doing nothing.
        try {
            await o.sendMessage(`@${event.redeemer.displayName} ${reason}`);
        } catch {
            // Chat being down must not stop the refund itself, which already ran.
        }
    }
}
