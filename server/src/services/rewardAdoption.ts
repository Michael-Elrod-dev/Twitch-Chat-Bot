import type { Logger } from '../logger.js';
import type { HelixApi, CustomReward } from '../twitch/helixApi.js';
import type { UserTokenProvider } from '../twitch/userTokenProvider.js';
import type { ChannelRewardRepository, RewardKind } from '../db/repositories/channelRewardRepository.js';

/**
 * Binds the bot's reward kinds to real Twitch rewards.
 *
 * The P1-WP3 finding made operational: only rewards **this application created**
 * can have their redemption status updated, so a reward we cannot manage is one
 * we must never route. `only_manageable_rewards=true` is the filter that decides
 * — and the WP6 live check confirmed the owner's existing production rewards
 * pass it, because the Phase-0 bot created them under this same client id.
 *
 * Adoption matches on title **once**, at bind time, and stores the id. From
 * then on routing is by id alone, so renaming a reward afterwards is harmless.
 * That is the whole difference from Phase 0, which re-matched the title on
 * every redemption.
 */

/** Titles the Phase-0 bot used. Matched case-insensitively, once, at adoption. */
export const KNOWN_REWARD_TITLES: Record<RewardKind, string[]> = {
    song_request: ['song request'],
    skip_queue: ['skip song queue', 'skip queue'],
    add_quote: ['add a quote', 'add quote']
};

/** Used only when a channel has no matching reward and one must be created. */
export const DEFAULT_REWARD_SPECS: Record<RewardKind, { title: string; cost: number; prompt: string }> = {
    song_request: {
        title: 'Song Request',
        cost: 100,
        prompt: 'Paste a Spotify link or search for a song to add it to the queue.'
    },
    skip_queue: {
        title: 'Skip song queue',
        cost: 200,
        prompt: 'Skip the currently queued song.'
    },
    add_quote: {
        title: 'Add a quote',
        cost: 1000,
        prompt: 'Format: "The quote" - Person who said it'
    }
};

export interface AdoptionResult {
    adopted: { kind: RewardKind; title: string }[];
    created: { kind: RewardKind; title: string }[];
    unchanged: RewardKind[];
    /** Rewards the app can manage but does not recognize - left alone. */
    ignored: string[];
    failures: { kind: RewardKind; reason: string }[];
}

export interface RewardAdoptionOptions {
    channelId: string;
    broadcasterTwitchId: string;
    helix: HelixApi;
    userTokens: UserTokenProvider;
    rewards: ChannelRewardRepository;
    logger: Logger;
    /**
     * Whether to create a reward that no existing one matches.
     *
     * Off by default. Creating channel-point rewards in someone's channel
     * without being asked is a visible, surprising act, so it is opt-in and
     * logged prominently when it happens.
     */
    createMissing?: boolean;
}

export class RewardAdoptionService {
    private readonly options: RewardAdoptionOptions;

    constructor(options: RewardAdoptionOptions) {
        this.options = options;
    }

    async reconcile(): Promise<AdoptionResult> {
        const o = this.options;
        const result: AdoptionResult = {
            adopted: [], created: [], unchanged: [], ignored: [], failures: []
        };

        const token = await o.userTokens.get();
        const manageable = await o.helix.listCustomRewards(o.broadcasterTwitchId, token, true);
        const existing = await o.rewards.listAll();
        const boundIds = new Set(existing.map((r) => r.rewardId));

        for (const kind of Object.keys(KNOWN_REWARD_TITLES) as RewardKind[]) {
            const already = existing.find((r) => r.kind === kind);

            // Still present at Twitch? Then nothing to do. A bound reward that
            // has been deleted falls through to adoption or creation.
            if (already && manageable.some((r) => r.id === already.rewardId)) {
                result.unchanged.push(kind);
                continue;
            }

            const match = findByTitle(manageable, KNOWN_REWARD_TITLES[kind]);
            if (match) {
                await o.rewards.upsert({ kind, rewardId: match.id, title: match.title });
                boundIds.add(match.id);
                result.adopted.push({ kind, title: match.title });

                o.logger.info(
                    { channelId: o.channelId, kind, title: match.title, rewardId: match.id },
                    'Adopted an existing channel-point reward'
                );
                continue;
            }

            if (!o.createMissing) {
                o.logger.warn(
                    { channelId: o.channelId, kind },
                    'No matching reward to adopt and creation is disabled - this reward kind is inactive'
                );
                continue;
            }

            try {
                const spec = DEFAULT_REWARD_SPECS[kind];
                const created = await o.helix.createCustomReward(o.broadcasterTwitchId, token, {
                    title: spec.title,
                    cost: spec.cost,
                    prompt: spec.prompt,
                    isUserInputRequired: kind !== 'skip_queue'
                });

                await o.rewards.upsert({ kind, rewardId: created.id, title: created.title });
                boundIds.add(created.id);
                result.created.push({ kind, title: created.title });

                // Prominent on purpose: a new reward has appeared in someone's
                // channel and they should be able to find out why from the log.
                o.logger.warn(
                    { channelId: o.channelId, kind, title: created.title, cost: spec.cost },
                    'CREATED a new channel-point reward in this channel'
                );
            } catch (err) {
                result.failures.push({ kind, reason: (err as Error).message });
                o.logger.error(
                    { channelId: o.channelId, kind, err: (err as Error).message },
                    'Could not create the reward'
                );
            }
        }

        // Manageable but unrecognized. Named in the log so the operator can see
        // what was left alone, but never touched.
        result.ignored = manageable.filter((r) => !boundIds.has(r.id)).map((r) => r.title);
        if (result.ignored.length > 0) {
            o.logger.info(
                { channelId: o.channelId, ignored: result.ignored },
                'Rewards left alone - not managed by the bot'
            );
        }

        return result;
    }
}

function findByTitle(rewards: CustomReward[], titles: string[]): CustomReward | undefined {
    const wanted = titles.map((t) => t.toLowerCase());
    return rewards.find((r) => wanted.includes(r.title.trim().toLowerCase()));
}
