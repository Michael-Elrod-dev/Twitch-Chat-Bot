const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');
const TokenManager = require('./tokenManager');

async function createSongRequestReward() {
    // Initialize TokenManager to get tokens
    const tokenManager = new TokenManager();
    await tokenManager.checkAndRefreshTokens();

    // Use tokens from TokenManager
    const CLIENT_ID = tokenManager.tokens.clientId;
    const OAUTH_TOKEN = tokenManager.tokens.broadcasterAccessToken;
    const BROADCASTER_ID = tokenManager.tokens.channelId;

    // Authenticate using broadcaster's OAuth token
    const authProvider = new StaticAuthProvider(CLIENT_ID, OAUTH_TOKEN);
    const apiClient = new ApiClient({ authProvider });

    try {
        // Get existing rewards to check for duplicates
        const rewards = await apiClient.channelPoints.getCustomRewards(BROADCASTER_ID);
        const existingReward = rewards.find(reward => reward.title === 'Song Request');

        if (existingReward) {
            console.log('Reward "Song Request" already exists.');
            return; // If reward exists, skip creation
        }

        // Create the "Song Request" custom reward
        const reward = await apiClient.channelPoints.createCustomReward(
            BROADCASTER_ID,
            {
                title: 'Song Request',
                prompt: 'Share a Spotify link to add to the queue', // Message prompt for the user
                cost: 100, // Points required for the redemption
                isEnabled: true,
                isUserInputRequired: true, // Ensures the user must provide input
                maxPerStream: 5, // You can adjust this based on how many requests you want per stream
            }
        );

        console.log('Custom reward created:', reward);
    } catch (error) {
        console.error('Error creating custom reward:', error);
    }
}

// Run the function to create the reward
createSongRequestReward();