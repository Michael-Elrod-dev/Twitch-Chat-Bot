// src/tokens/redemptionCreation.js

const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');
const TokenManager = require('./tokenManager');
const logger = require('../logger/logger');

async function createChannelPointReward(rewardConfig) {
    const tokenManager = new TokenManager();
    await tokenManager.checkAndRefreshTokens();

    const CLIENT_ID = tokenManager.tokens.clientId;
    const OAUTH_TOKEN = tokenManager.tokens.broadcasterAccessToken;
    const BROADCASTER_ID = tokenManager.tokens.channelId;

    const authProvider = new StaticAuthProvider(CLIENT_ID, OAUTH_TOKEN);
    const apiClient = new ApiClient({ authProvider });

    try {
        const rewards = await apiClient.channelPoints.getCustomRewards(BROADCASTER_ID);
        const existingReward = rewards.find(reward => reward.title === rewardConfig.title);

        if (existingReward) {
            logger.info('RedemptionCreation', 'Reward already exists', { title: rewardConfig.title });
            return;
        }

        const reward = await apiClient.channelPoints.createCustomReward(BROADCASTER_ID, rewardConfig);

        logger.info('RedemptionCreation', 'Custom reward created successfully', {
            title: reward.title,
            cost: reward.cost,
            id: reward.id
        });
    } catch (error) {
        logger.error('RedemptionCreation', 'Error creating custom reward', {
            error: error.message,
            stack: error.stack,
            rewardTitle: rewardConfig.title
        });
    }
}

createChannelPointReward({
    title: 'Pick the game',
    prompt: 'Pick any game from Steam and I will play it on the next stream',
    cost: 50000,
    isEnabled: true,
    backgroundColor: '#000000',
    userInputRequired: true,
    shouldRedemptionsSkipRequestQueue: false,

    isMaxPerStreamEnabled: false,

    isMaxPerUserPerStreamEnabled: false,

    isGlobalCooldownEnabled: false,
});
