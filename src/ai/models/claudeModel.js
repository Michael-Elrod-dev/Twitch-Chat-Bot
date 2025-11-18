// src/ai/models/claudeModel.js

const fetch = require('node-fetch');
const config = require('../../config/config');
const logger = require('../../logger/logger');

class ClaudeModel {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async getTextResponse(prompt, context = {}, systemPrompt = null) {
        const startTime = Date.now();

        const systemMessage = systemPrompt || config.aiSettings.claude.systemPrompt;

        logger.debug('ClaudeModel', 'Sending request to Claude API', {
            promptLength: prompt.length,
            systemPromptLength: systemMessage?.length,
            model: config.aiModels.claude.model,
            userName: context.userName
        });

        try {
            const response = await fetch(`${config.claudeApiEndpoint}/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': config.aiModels.claude.apiVersion,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: config.aiModels.claude.model,
                    max_tokens: config.aiModels.claude.maxTokens,
                    temperature: config.aiModels.claude.temperature,
                    system: systemMessage,
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

            const responseTime = Date.now() - startTime;
            const responseText = data.content[0].text.trim();

            logger.info('ClaudeModel', 'Successfully received Claude API response', {
                promptLength: prompt.length,
                responseLength: responseText.length,
                responseTime,
                userName: context.userName
            });

            return responseText;
        } catch (error) {
            const responseTime = Date.now() - startTime;
            logger.error('ClaudeModel', 'Error getting Claude response', {
                error: error.message,
                stack: error.stack,
                promptLength: prompt.length,
                responseTime,
                userName: context.userName
            });
            return null;
        }
    }
}

module.exports = ClaudeModel;
