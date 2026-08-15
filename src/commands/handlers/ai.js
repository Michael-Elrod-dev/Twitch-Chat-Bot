const logger = require('../../logger/logger');

const AI_ENABLED_CACHE_KEY = 'cache:settings:aiEnabled';

function aiHandlers(dependencies = {}) {
    return {
        async toggleAI(twitchBot, channel, context, args) {
            try {
    
                if (!args[0] || (args[0].toLowerCase() !== 'on' && args[0].toLowerCase() !== 'off')) {
                    await twitchBot.sendMessage(channel, 'Usage: !ai <on|off>');
                    return;
                }

                const enable = args[0].toLowerCase() === 'on';

                const getCurrentStateSql = 'SELECT token_value FROM tokens WHERE token_key = ?';
                const result = await twitchBot.analyticsManager.dbManager.query(getCurrentStateSql, ['aiEnabled']);

                const currentState = result.length > 0 && result[0].token_value === 'true';

                if (currentState === enable) {
                    await twitchBot.sendMessage(channel, `AI responses are already turned ${enable ? 'on' : 'off'}`);
                    return;
                }

                const updateStateSql = `
                    INSERT INTO tokens (token_key, token_value)
                    VALUES ('aiEnabled', ?)
                    ON DUPLICATE KEY UPDATE token_value = ?, updated_at = CURRENT_TIMESTAMP
                `;
                await twitchBot.analyticsManager.dbManager.query(updateStateSql, [enable.toString(), enable.toString()]);

                // Without this the toggle took up to the cache TTL to take effect.
                const redisManager = dependencies.redisManager || twitchBot.redisManager;
                if (redisManager && redisManager.connected()) {
                    await redisManager.getCacheManager().del(AI_ENABLED_CACHE_KEY);
                    logger.debug('AIHandlers', 'Invalidated AI enabled cache');
                }

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

aiHandlers.levels = {
    toggleAI: 'mod'
};

module.exports = aiHandlers;
