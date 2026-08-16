import { and, eq } from 'drizzle-orm';
import { channelRewards } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export type RewardKind = 'song_request' | 'skip_queue' | 'add_quote';

export interface ChannelRewardRecord {
    kind: RewardKind;
    rewardId: string;
    title: string;
}

/**
 * The rewards this application manages, per channel.
 *
 * Membership here is what makes a redemption ours to act on. A reward the
 * broadcaster created by hand is absent, and therefore never touched — the
 * P1-WP3 policy, enforced by a lookup rather than by a title comparison.
 */
export class ChannelRewardRepository extends ChannelScopedRepository {
    async listAll(): Promise<ChannelRewardRecord[]> {
        return this.db
            .select({
                kind: channelRewards.kind,
                rewardId: channelRewards.rewardId,
                title: channelRewards.title
            })
            .from(channelRewards)
            .where(eq(channelRewards.channelId, this.channelId));
    }

    /** The routing lookup. Keyed on the id, never the title. */
    async findByRewardId(rewardId: string): Promise<ChannelRewardRecord | null> {
        const [row] = await this.db
            .select({
                kind: channelRewards.kind,
                rewardId: channelRewards.rewardId,
                title: channelRewards.title
            })
            .from(channelRewards)
            .where(and(eq(channelRewards.channelId, this.channelId), eq(channelRewards.rewardId, rewardId)));

        return row ?? null;
    }

    async findByKind(kind: RewardKind): Promise<ChannelRewardRecord | null> {
        const [row] = await this.db
            .select({
                kind: channelRewards.kind,
                rewardId: channelRewards.rewardId,
                title: channelRewards.title
            })
            .from(channelRewards)
            .where(and(eq(channelRewards.channelId, this.channelId), eq(channelRewards.kind, kind)));

        return row ?? null;
    }

    /**
     * Records an adopted or created reward.
     *
     * Conflicts on `kind`, so re-adopting after a reward is recreated updates
     * the id rather than leaving the channel pointing at a reward that no
     * longer exists.
     */
    async upsert(record: ChannelRewardRecord): Promise<void> {
        await this.db
            .insert(channelRewards)
            .values({ channelId: this.channelId, ...record })
            .onConflictDoUpdate({
                target: [channelRewards.channelId, channelRewards.kind],
                set: { rewardId: record.rewardId, title: record.title, updatedAt: new Date() }
            });
    }

    async remove(kind: RewardKind): Promise<boolean> {
        const removed = await this.db
            .delete(channelRewards)
            .where(and(eq(channelRewards.channelId, this.channelId), eq(channelRewards.kind, kind)))
            .returning({ id: channelRewards.id });

        return removed.length > 0;
    }
}
