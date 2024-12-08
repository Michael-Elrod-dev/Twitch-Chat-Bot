// src/bot.js
const tmi = require('tmi.js');
const TokenManager = require('./tokenManager');
const CommandManager = require('./commandManager');

const tokenManager = new TokenManager();
const client = new tmi.client(tokenManager.getConfig());

// Register our event handlers
client.on('message', onMessageHandler);
client.on('connected', onConnectedHandler);
client.on('disconnected', async (reason) => {
    console.log(`* Bot disconnected: ${reason}`);
    try {
        await tokenManager.refreshToken();
        client.connect();
    } catch (error) {
        console.error('Failed to refresh token:', error);
    }
});

// Connect to Twitch
client.connect();

// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
    if (self) return; // Ignore messages from the bot itself
    
    // Remove whitespace from chat message
    const message = msg.trim();
    
    // Handle commands through the command manager
    await CommandManager.handleCommand(client, target, context, message);
}

// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port) {
    console.log(`* Connected to ${addr}:${port}`);
}

module.exports = client;