// src/ai/models/openaiModel.js

const fetch = require('node-fetch');
const config = require('../../config/config');

class OpenAIModel {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async generateImage(prompt, context = {}) {
        try {
            console.log(`🎨 Generating image for prompt: "${prompt}"`);

            // Enhance the prompt with safety and style guidelines
            const enhancedPrompt = `${config.aiSettings.openai.imagePromptPrefix}${prompt}. ${config.aiSettings.openai.styleInstructions}`;

            const response = await fetch(`${config.openaiApiEndpoint}/images/generations`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: config.aiModels.openai.model,
                    prompt: enhancedPrompt,
                    size: config.aiModels.openai.imageSize,
                    quality: config.aiModels.openai.imageQuality,
                    n: 1,
                    response_format: 'url'
                })
            });

            const data = await response.json();

            if (!response.ok) {
                console.error('❌ OpenAI API error:', data);
                throw new Error(`OpenAI API error: ${data.error?.message || 'Unknown error'}`);
            }

            if (data.data && data.data[0] && data.data[0].url) {
                console.log('✅ Image generated successfully');
                return data.data[0].url;
            }

            throw new Error('No image URL returned from OpenAI');
        } catch (error) {
            console.error('❌ Error generating image:', error);
            return null;
        }
    }
}

module.exports = OpenAIModel;
