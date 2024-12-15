const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');

// Your broadcaster's access token and bot's client ID
const CLIENT_ID = '8e24bqxf7e8ckaqx628ad01r911dxu';  // Your bot's client ID
const OAUTH_TOKEN = 'l5723gqitkrkd61voqyryek1gz0ccw'; // Broadcaster's access token
const BROADCASTER_ID = '89468164';  // Replace with your broadcaster's user ID

async function createSongRequestReward() {
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
                // Optionally, you can adjust the reward settings to require specific input
            }
        );

        console.log('Custom reward created:', reward);
    } catch (error) {
        console.error('Error creating custom reward:', error);
    }
}

// Run the function to create the reward
createSongRequestReward();
