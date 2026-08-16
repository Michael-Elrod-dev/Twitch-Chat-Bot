import { and, eq, isNull } from 'drizzle-orm';
import { apiUsage, channels } from '../db/schema/index.js';
import type { Database } from '../db/client.js';
import type { ChatterRoles } from '../domain/permissions.js';

/**
 * Per-channel, per-stream AI budgets.
 *
 * Ported from Phase 0's rateLimiter with the scope corrected: the counter is
 * keyed by channel as well as by user and stream, so a viewer who follows the
 * bot across channels gets a fresh budget in each. Phase 0 could not express
 * that because it only ever served one channel.
 *
 * Limits are the **maximum** of every applicable tier rather than a lookup of
 * the highest role, which is Phase 0's behaviour and the right one: a
 * subscriber who is also a VIP should get the better of the two, not whichever
 * the code happens to check first.
 */

export interface StreamLimits {
    broadcaster: number;
    mod: number;
    subscriber: number;
    vip: number;
    everyone: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
    broadcaster: 999_999,
    mod: 15,
    subscriber: 15,
    vip: 10,
    everyone: 5
};

export interface RateLimitDecision {
    allowed: boolean;
    /** Usage *before* this request, so a caller can render "3/5". */
    used: number;
    limit: number;
}

export function limitFor(roles: ChatterRoles, limits: StreamLimits = DEFAULT_STREAM_LIMITS): number {
    const applicable = [limits.everyone];

    if (roles.isSubscriber) applicable.push(limits.subscriber);
    if (roles.isVip) applicable.push(limits.vip);
    if (roles.isModerator) applicable.push(limits.mod);
    if (roles.isBroadcaster) applicable.push(limits.broadcaster);

    return Math.max(...applicable);
}

export interface AiRateLimiterOptions {
    db: Database;
    channelId: string;
    limits?: StreamLimits;
}

const SERVICE = 'claude';

export class AiRateLimiter {
    private readonly db: Database;
    private readonly channelId: string;
    private readonly limits: StreamLimits;

    constructor(options: AiRateLimiterOptions) {
        this.db = options.db;
        this.channelId = options.channelId;
        this.limits = options.limits ?? DEFAULT_STREAM_LIMITS;
    }

    /**
     * @param streamId null when the channel is offline, which is a legitimate
     * bucket of its own rather than an error — Phase 0 treated offline usage as
     * one long stream, and the same applies here.
     */
    async check(twitchUserId: string, roles: ChatterRoles, streamId: string | null): Promise<RateLimitDecision> {
        const limit = limitFor(roles, this.limits);
        const used = await this.currentUsage(twitchUserId, streamId);

        return { allowed: used < limit, used, limit };
    }

    /**
     * Records one use and returns the new total.
     *
     * Deliberately NOT an ON CONFLICT upsert. The unique index cannot match
     * rows where `stream_id` is null — Postgres treats NULLs in a unique index
     * as distinct — which is precisely the offline bucket, so an upsert would
     * insert a fresh row every time and the limit would never apply off-stream.
     *
     * Instead the read-then-write is serialised per channel by locking the
     * parent `channels` row, the same shape the quote numbering uses. Two
     * simultaneous requests would otherwise both read the same count and both
     * write it back plus one, letting a viewer spend the same slot twice.
     */
    async record(twitchUserId: string, streamId: string | null): Promise<number> {
        return this.db.transaction(async (tx) => {
            await tx
                .select({ id: channels.id })
                .from(channels)
                .where(eq(channels.id, this.channelId))
                .for('update');

            const matches = and(
                eq(apiUsage.channelId, this.channelId),
                eq(apiUsage.twitchUserId, twitchUserId),
                eq(apiUsage.apiType, SERVICE),
                streamId === null ? isNull(apiUsage.streamId) : eq(apiUsage.streamId, streamId)
            );

            const [existing] = await tx
                .select({ id: apiUsage.id, usageCount: apiUsage.usageCount })
                .from(apiUsage)
                .where(matches);

            if (existing) {
                const next = existing.usageCount + 1;
                await tx.update(apiUsage)
                    .set({ usageCount: next, updatedAt: new Date() })
                    .where(eq(apiUsage.id, existing.id));
                return next;
            }

            await tx.insert(apiUsage).values({
                channelId: this.channelId,
                twitchUserId,
                streamId,
                apiType: SERVICE,
                usageCount: 1
            });
            return 1;
        });
    }

    private async currentUsage(twitchUserId: string, streamId: string | null): Promise<number> {
        const [row] = await this.db
            .select({ usageCount: apiUsage.usageCount })
            .from(apiUsage)
            .where(and(
                eq(apiUsage.channelId, this.channelId),
                eq(apiUsage.twitchUserId, twitchUserId),
                eq(apiUsage.apiType, SERVICE),
                // A null stream id needs IS NULL; `= null` matches nothing and
                // would silently reset every offline user's budget each call.
                streamId === null ? isNull(apiUsage.streamId) : eq(apiUsage.streamId, streamId)
            ));

        return row?.usageCount ?? 0;
    }
}
