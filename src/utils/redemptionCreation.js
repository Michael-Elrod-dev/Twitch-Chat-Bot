const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');
const TokenManager = require('./tokenManager');

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
            console.log(`Reward "${rewardConfig.title}" already exists.`);
            return;
        }

        // Directly use rewardConfig as provided
        const reward = await apiClient.channelPoints.createCustomReward(BROADCASTER_ID, rewardConfig);

        console.log(`Custom reward "${reward.title}" created successfully:`, reward);
    } catch (error) {
        console.error('Error creating custom reward:', error);
    }
}

// Example usage: specifying all fields directly, even if disabled
createChannelPointReward({
    title: 'Add a quote',
    prompt: "Add a !quote from either stream or something someone said in chat. The format should be:\n'What was said in quotes' - Who said it",
    cost: 1000,
    isEnabled: true,
    backgroundColor: '#E69900',
    userInputRequired: true,
    shouldRedemptionsSkipRequestQueue: false,

    // Enable maximum per stream (disabled for now)
    isMaxPerStreamEnabled: false,
    // maxPerStream: 5,

    // Enable maximum per user per stream (disabled for now)
    isMaxPerUserPerStreamEnabled: false,
    // maxPerUserPerStream: 2,

    // Enable global cooldown (disabled for now)
    isGlobalCooldownEnabled: false,
    // globalCooldown: 300
});


