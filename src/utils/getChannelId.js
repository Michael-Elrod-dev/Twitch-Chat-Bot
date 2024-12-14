// getChannelId.js
const fs = require('fs');
const path = require('path');

async function getChannelId() {
    try {
        const fetch = (await import('node-fetch')).default;
        
        // Read tokens from JSON file
        const tokensJson = fs.readFileSync(path.join(__dirname, '../../files/tokens.json'), 'utf8');
        const tokens = JSON.parse(tokensJson);

        // Log the headers we're using (without exposing full token)
        console.log('Using ClientID:', tokens.clientId);
        console.log('Using AccessToken:', tokens.accessToken.substring(0, 5) + '...');

        const response = await fetch('https://api.twitch.tv/helix/users?login=aimosthadme', {
            headers: {
                'Authorization': `Bearer ${tokens.accessToken.trim()}`,
                'Client-Id': tokens.clientId.trim()
            }
        });

        const data = await response.json();
        
        // Log the response status
        console.log('Response status:', response.status);
        
        if (data.data && data.data[0]) {
            console.log('Your Channel ID is:', data.data[0].id);
            console.log('Add this to your tokens.json file as:');
            console.log(JSON.stringify({
                ...tokens,
                channelId: data.data[0].id
            }, null, 4));
        } else {
            console.log('Error: Could not find channel');
            console.log('Response data:', data);
        }
    } catch (error) {
        console.error('Detailed error:', error);
        if (error.response) {
            const text = await error.response.text();
            console.log('Response text:', text);
        }
    }
}

getChannelId();