import type { Logger } from '../logger.js';
import type { HelixApi } from '../twitch/helixApi.js';
import type { UserTokenProvider } from '../twitch/userTokenProvider.js';
import type { SettingsService } from './settings.js';
import type { ChannelRewardRepository } from '../db/repositories/channelRewardRepository.js';

/**
 * Turning song requests on and off.
 *
 * Ported from Phase 0's songToggleService, and the important half is the part
 * that is easy to skip: **the reward itself is disabled at Twitch**, not just a
 * flag in our database.
 *
 * A flag alone leaves the reward visible and redeemable. A viewer spends their
 * points, the bot refuses and refunds, and from their side the reward is simply
 * broken. Disabling it removes it from the channel-point menu, which is what
 * "off" looks like to the person deciding whether to spend.
 */

export interface SongToggleOptions {
    channelId: string;
    broadcasterTwitchId: string;
    settings: SettingsService;
    rewards: ChannelRewardRepository;
    helix: HelixApi;
    userTokens: UserTokenProvider;
    logger: Logger;
}

export interface ToggleResult {
    enabled: boolean;
    /** False when the database was updated but Twitch was not. */
    rewardUpdated: boolean;
}

export class SongToggleService {
    private readonly options: SongToggleOptions;

    constructor(options: SongToggleOptions) {
        this.options = options;
    }

    async isEnabled(): Promise<boolean> {
        return (await this.options.settings.get()).songRequestsEnabled;
    }

    async setEnabled(enabled: boolean): Promise<ToggleResult> {
        const o = this.options;

        // The setting first: it is the one the request handler checks, so if
        // the Twitch call fails the bot still refuses requests rather than
        // accepting them against the operator's stated intent.
        await o.settings.update({ songRequestsEnabled: enabled });

        const reward = await o.rewards.findByKind('song_request');
        if (!reward) {
            o.logger.warn(
                { channelId: o.channelId, enabled },
                'Song requests toggled, but no song-request reward is bound - nothing to enable or disable at Twitch'
            );
            return { enabled, rewardUpdated: false };
        }

        try {
            const token = await o.userTokens.get();
            await o.helix.setCustomRewardEnabled(o.broadcasterTwitchId, token, reward.rewardId, enabled);

            o.logger.info(
                { channelId: o.channelId, enabled, rewardId: reward.rewardId },
                'Song request reward updated at Twitch'
            );
            return { enabled, rewardUpdated: true };
        } catch (err) {
            // Reported rather than thrown: the setting is already correct, so
            // the bot behaves properly even though the reward is still visible.
            o.logger.error(
                { channelId: o.channelId, enabled, err: (err as Error).message },
                'Could not update the reward at Twitch - the setting changed but the reward is still visible in chat'
            );
            return { enabled, rewardUpdated: false };
        }
    }
}
