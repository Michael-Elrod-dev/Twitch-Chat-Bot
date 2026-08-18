import type { RedemptionEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { HelixApi } from '../twitch/helixApi.js';
import type { UserTokenProvider } from '../twitch/userTokenProvider.js';
import { RateLimitedError, ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * Marks a redemption fulfilled or refunded.
 *
 * Update Redemption Status accepts only a broadcaster user token with
 * `channel:manage:redemptions`, which is the entire reason `channel_tokens`
 * exists and why this calls `UserTokenProvider`.
 *
 * A rate limit on the refund path gets one bounded retry after the reset hint
 * and never a drop. An unrefunded failed redemption is stolen channel points,
 * and "the server was rate limited" is not something the viewer can see or act
 * on. Fulfillment is not retried, because the viewer already got what they paid
 * for and the status is cosmetic by comparison.
 */

export type RedemptionStatus = 'FULFILLED' | 'CANCELED';

/** A retry that waits longer than this is worse than failing loudly now. */
const MAX_RETRY_WAIT_MS = 30_000;

export interface RedemptionSettlementOptions {
    channelId: string;
    broadcasterTwitchId: string;
    helix: HelixApi;
    userTokens: UserTokenProvider;
    logger: Logger;
    sleep?: (ms: number) => Promise<void>;
}

export class RedemptionSettlement {
    private readonly options: RedemptionSettlementOptions;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(options: RedemptionSettlementOptions) {
        this.options = options;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    /** @throws when the status could not be set; the caller logs it loudly. */
    async settle(event: RedemptionEvent, status: RedemptionStatus): Promise<void> {
        const o = this.options;

        try {
            await this.send(event, status);
        } catch (err) {
            // Only a refund is worth retrying, and only for a rate limit.
            if (status === 'CANCELED' && err instanceof RateLimitedError) {
                const waitMs = Math.min(err.retryAfterMs, MAX_RETRY_WAIT_MS);

                o.logger.warn(
                    { channelId: o.channelId, redemptionId: event.redemptionId, waitMs },
                    'Refund rate limited - retrying once after the reset hint rather than dropping it'
                );

                await this.sleep(waitMs);
                // One retry. If this fails the caller logs it as a manual
                // refund, which is far better than a silent loop.
                await this.send(event, status);
                return;
            }

            if (err instanceof ManualReauthRequiredError) {
                // The broadcaster's token is dead, so nothing can settle until
                // they reconnect. Naming that is more useful than the raw error.
                o.logger.error(
                    { channelId: o.channelId, redemptionId: event.redemptionId },
                    'Cannot settle redemption: the broadcaster must reconnect via /auth/twitch/connect'
                );
            }

            throw err;
        }
    }

    private async send(event: RedemptionEvent, status: RedemptionStatus): Promise<void> {
        const token = await this.options.userTokens.get();

        await this.options.helix.updateRedemptionStatus(
            this.options.broadcasterTwitchId,
            token,
            event.rewardId,
            event.redemptionId,
            status
        );
    }
}
