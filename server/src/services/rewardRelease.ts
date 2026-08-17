import type { Logger } from '../logger.js';
import type { ChannelRewardRepository, RewardKind } from '../db/repositories/channelRewardRepository.js';

/**
 * Letting go of the three managed rewards when a channel disconnects.
 *
 * The mirror of `RewardAdoptionService`, and deliberately much smaller: adoption
 * has to decide what to bind, this only has to undo what was bound. It walks the
 * rows the app itself wrote, so a reward it never bound cannot be touched by it —
 * the trust card's claim ("anything else on your channel it will not touch,
 * ever") holds here structurally rather than by care.
 *
 * **Disabled, never deleted, and uniformly.** The first version deleted them,
 * because the danger card said the rewards "go away" and deleting is the literal
 * reading. It is also irreversible and reaches past this application: two of the
 * owner's three rewards were *adopted* from the Phase-0 bot, so they predate this
 * codebase entirely, and deleting one destroys a reward's title, cost, prompt and
 * redemption history — none of which this app created and none of which it can
 * put back. Disabling reaches exactly as far as the promise requires: nobody can
 * redeem it, no points are taken, and everything the streamer configured survives
 * for a channel they may reconnect. `setCustomRewardEnabled` is the same call the
 * songs toggle already makes, so this is not a new capability either.
 *
 * **Every step is best-effort and none of them can stop the disconnect.** A
 * streamer who has asked the bot to leave must not be told "no" because Twitch
 * returned a 500, and a channel left recorded as connected because a cleanup
 * failed is the worse of the two wrong states. So each reward is attempted
 * independently, failures are logged with the kind that failed, and the binding
 * row is forgotten regardless.
 *
 * Forgetting the row even when the disable failed is the deliberate half. The
 * alternative — keeping it so a retry could find it — would leave a disconnected
 * channel routing redemptions for a reward it still believes it manages. If the
 * reward really does survive enabled at Twitch, it survives as an ordinary reward
 * of the streamer's that this application no longer knows about, which is
 * precisely where it belongs once the bot has gone.
 */

export interface RewardReleasePorts {
    /**
     * Switches one reward off at Twitch. Rejecting is expected and survivable.
     *
     * Disable, not delete — see the note above. The name says which, so a future
     * edit cannot quietly make this destructive again while the call site still
     * reads as a release.
     */
    disableReward: (rewardId: string) => Promise<void>;
    rewards: ChannelRewardRepository;
    logger: Logger;
    channelId: string;
}

export interface RewardReleaseResult {
    /** Kinds switched off at Twitch. */
    disabled: RewardKind[];
    /** Bindings dropped whose Twitch disable did not succeed. */
    failed: { kind: RewardKind; reason: string }[];
}

export async function releaseManagedRewards(
    ports: RewardReleasePorts
): Promise<RewardReleaseResult> {
    const result: RewardReleaseResult = { disabled: [], failed: [] };
    const bound = await ports.rewards.listAll();

    for (const reward of bound) {
        try {
            await ports.disableReward(reward.rewardId);
            result.disabled.push(reward.kind);
        } catch (err) {
            result.failed.push({ kind: reward.kind, reason: (err as Error).message });
            ports.logger.error(
                {
                    channelId: ports.channelId,
                    kind: reward.kind,
                    rewardId: reward.rewardId,
                    err: (err as Error).message
                },
                'Could not disable a managed reward at Twitch - forgetting the binding anyway'
            );
        }

        // Outside the try on purpose: see the note above about why the row goes
        // whether or not Twitch cooperated.
        await ports.rewards.remove(reward.kind);
    }

    ports.logger.warn(
        { channelId: ports.channelId, disabled: result.disabled, failed: result.failed.length },
        'Disabled the managed channel-point rewards for a disconnecting channel'
    );

    return result;
}
