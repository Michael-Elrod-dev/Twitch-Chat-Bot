// src/ai/discordUploader.js

const fetch = require('node-fetch');
const FormData = require('form-data');

class DiscordUploader {
    constructor(webhookUrl) {
        // Add ?wait=true to get the message data back
        this.webhookUrl = webhookUrl.includes('?')
            ? `${webhookUrl}&wait=true`
            : `${webhookUrl}?wait=true`;
    }

    async uploadImage(imageUrl, username, prompt) {
        try {
            console.log(`📤 Uploading image to Discord for ${username}`);

            // Download the image from OpenAI
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
                throw new Error('Failed to download image from OpenAI');
            }

            const imageBuffer = await imageResponse.buffer();

            // Create form data for Discord webhook
            const form = new FormData();
            form.append('username', 'AlmostHadAi');
            form.append('content', `Generated for @${username}: "${prompt}"`);
            form.append('file', imageBuffer, {
                filename: `ai-image-${Date.now()}.png`,
                contentType: 'image/png'
            });

            // Upload to Discord
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                body: form
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Discord upload failed: ${response.status} - ${errorText}`);
            }

            // Get the message data to extract the image URL
            const messageData = await response.json();

            // Extract the Discord CDN URL from the attachments
            if (messageData.attachments && messageData.attachments[0]) {
                const discordImageUrl = messageData.attachments[0].url;
                console.log('✅ Image uploaded to Discord successfully');
                return discordImageUrl;
            }

            throw new Error('No attachment URL found in Discord response');
        } catch (error) {
            console.error('❌ Error uploading to Discord:', error);
            return null;
        }
    }
}

module.exports = DiscordUploader;
