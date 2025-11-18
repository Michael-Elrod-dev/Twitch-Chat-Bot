// src/commands/handlers/ai.js

const logger = require('../../logger/logger');

/**
 * AI-related command handlers
 */
function aiHandlers() {
    return {
        async toggleAI(twitchBot, channel, context, args) {
            try {
                if (!context.mod && !context.badges?.broadcaster) return;

                // Parse the on/off argument
                if (!args[0] || (args[0].toLowerCase() !== 'on' && args[0].toLowerCase() !== 'off')) {
                    await twitchBot.sendMessage(channel, 'Usage: !ai <on|off>');
                    return;
                }

                const enable = args[0].toLowerCase() === 'on';

                // Get current AI state from database
                const getCurrentStateSql = 'SELECT token_value FROM tokens WHERE token_key = ?';
                const result = await twitchBot.analyticsManager.dbManager.query(getCurrentStateSql, ['aiEnabled']);

                const currentState = result.length > 0 && result[0].token_value === 'true';

                // Check if AI is already in the desired state
                if (currentState === enable) {
                    await twitchBot.sendMessage(channel, `AI responses are already turned ${enable ? 'on' : 'off'}`);
                    return;
                }

                // Update AI state in database
                const updateStateSql = `
                    INSERT INTO tokens (token_key, token_value)
                    VALUES ('aiEnabled', ?)
                    ON DUPLICATE KEY UPDATE token_value = ?, updated_at = CURRENT_TIMESTAMP
                `;
                await twitchBot.analyticsManager.dbManager.query(updateStateSql, [enable.toString(), enable.toString()]);

                await twitchBot.sendMessage(channel, `AI responses have been turned ${enable ? 'on' : 'off'}`);
                logger.info('AIHandlers', 'AI responses toggled', {
                    channel,
                    enabled: enable,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('AIHandlers', 'Error toggling AI', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, `Failed to ${args[0]?.toLowerCase() === 'on' ? 'enable' : 'disable'} AI responses: ${error.message}`);
            }
        }
    };
}

module.exports = aiHandlers;
