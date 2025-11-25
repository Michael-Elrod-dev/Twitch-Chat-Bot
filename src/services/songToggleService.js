// src/services/songToggleService.js

const logger = require('../logger/logger');

class SongToggleService {
    constructor(twitchBot) {
        this.twitchBot = twitchBot;
    }

    async getCurrentStatus(channelName) {
        try {
            const channelId = await this.twitchBot.getUserByName(channelName);
            if (!channelId) {
                logger.error('SongToggleService', 'Channel not found', { channel: channelName });
                return null;
            }

            const rewards = await this.twitchBot.getCustomRewards(channelId.id);
            const songReward = rewards.find(reward => reward.title.toLowerCase() === 'song request');

            if (!songReward) {
                logger.warn('SongToggleService', 'Song request reward not found', { channel: channelName });
                return null;
            }

            return songReward.is_enabled;
        } catch (error) {
            logger.error('SongToggleService', 'Error getting song status', {
                error: error.message,
                stack: error.stack,
                channel: channelName
            });
            return null;
        }
    }

    async toggleSongs(channelName, enable) {
        try {
            const channelId = await this.twitchBot.getUserByName(channelName);
            if (!channelId) {
                logger.error('SongToggleService', 'Channel not found', { channel: channelName });
                return {
                    success: false,
                    message: 'Channel not found',
                    enabled: null
                };
            }

            const rewards = await this.twitchBot.getCustomRewards(channelId.id);
            const songReward = rewards.find(reward => reward.title.toLowerCase() === 'song request');
            const skipQueueReward = rewards.find(reward => reward.title.toLowerCase() === 'skip song queue');

            if (!songReward || !skipQueueReward) {
                logger.warn('SongToggleService', 'Song rewards not found', {
                    channel: channelName,
                    hasSongReward: !!songReward,
                    hasSkipReward: !!skipQueueReward
                });
                return {
                    success: false,
                    message: 'Could not find one or both song-related rewards',
                    enabled: null
                };
            }

            if (songReward.is_enabled === enable && skipQueueReward.is_enabled === enable) {
                return {
                    success: true,
                    message: `Song requests are already turned ${enable ? 'on' : 'off'}`,
                    enabled: enable,
                    alreadyInState: true
                };
            }

            await Promise.all([
                this.twitchBot.updateCustomReward(channelId.id, songReward.id, {
                    is_enabled: enable
                }),
                this.twitchBot.updateCustomReward(channelId.id, skipQueueReward.id, {
                    is_enabled: enable
                })
            ]);

            logger.info('SongToggleService', 'Song requests toggled', {
                channel: channelName,
                enabled: enable
            });

            return {
                success: true,
                message: `Song requests have been turned ${enable ? 'on' : 'off'}`,
                enabled: enable,
                alreadyInState: false
            };
        } catch (error) {
            logger.error('SongToggleService', 'Error toggling songs', {
                error: error.message,
                stack: error.stack,
                channel: channelName,
                enable
            });
            return {
                success: false,
                message: `Failed to ${enable ? 'enable' : 'disable'} song requests: ${error.message}`,
                enabled: null
            };
        }
    }

    async toggle(channelName) {
        const currentStatus = await this.getCurrentStatus(channelName);
        if (currentStatus === null) {
            return {
                success: false,
                message: 'Could not determine current song request status',
                enabled: null
            };
        }

        return await this.toggleSongs(channelName, !currentStatus);
    }
}

module.exports = SongToggleService;
