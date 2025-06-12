// src/models/claudeModel.js
const fetch = require('node-fetch');
const config = require('../../config/config');

class ClaudeModel {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async getTextResponse(prompt, context = {}) {
        try {
            const response = await fetch(`${config.aiModels.claude.apiEndpoint}/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: config.aiModels.claude.model,
                    max_tokens: config.aiModels.claude.maxTokens,
                    temperature: config.aiModels.claude.temperature,
                    system: config.aiSettings.claude.systemPrompt,
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ]
                })
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(`Claude API error: ${data.error?.message || 'Unknown error'}`);
            }

            return data.content[0].text.trim();
        } catch (error) {
            console.error('❌ Error getting Claude response:', error);
            return null;
        }
    }
}

module.exports = ClaudeModel;