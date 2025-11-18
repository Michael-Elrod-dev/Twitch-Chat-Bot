// src/commands/handlers/stats.js

const logger = require('../../logger/logger');

/**
 * Analytics and statistics command handlers
 */
function statsHandlers() {
    return {
        async combinedStats(twitchBot, channel, context, args) {
            let requestedUser;
            try {
                requestedUser = args[0]?.replace('@', '').toLowerCase() || context.username.toLowerCase();
                const messages = await twitchBot.viewerManager.getUserMessages(requestedUser);
                const commands = await twitchBot.viewerManager.getUserCommands(requestedUser);
                const redemptions = await twitchBot.viewerManager.getUserRedemptions(requestedUser);
                const total = messages + commands + redemptions;

                await twitchBot.sendMessage(channel,
                    `@${requestedUser} has ${total} total interactions ` +
                    `(${messages} messages, ${commands} commands, ${redemptions} redemptions)`
                );
                logger.info('StatsHandlers', 'Combined stats command executed', {
                    channel,
                    targetUser: requestedUser,
                    total,
                    messages,
                    commands,
                    redemptions,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('StatsHandlers', 'Error in combinedStats', { error: error.message, stack: error.stack, channel, targetUser: requestedUser });
                await twitchBot.sendMessage(channel, 'An error occurred while fetching chat stats.');
            }
        },

        async topStats(twitchBot, channel, context) {
            try {
                if (!twitchBot.viewerManager && twitchBot.analyticsManager?.viewerTracker) {
                    logger.debug('StatsHandlers', 'Using viewerTracker directly for topStats', { channel });
                    const topUsers = await twitchBot.analyticsManager.viewerTracker.getTopUsers(5);
                    await twitchBot.sendMessage(channel, `Top 5 Most Active Viewers: ${topUsers.join(' | ')}`);
                    logger.info('StatsHandlers', 'Top stats command executed', {
                        channel,
                        topUsers: topUsers.length,
                        requestedBy: context.username
                    });
                    return;
                }

                const topUsers = await twitchBot.viewerManager.getTopUsers(5);
                await twitchBot.sendMessage(channel, `Top 5 Most Active Viewers: ${topUsers.join(' | ')}`);
                logger.info('StatsHandlers', 'Top stats command executed', {
                    channel,
                    topUsers: topUsers.length,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('StatsHandlers', 'Error in topStats', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'An error occurred while fetching top stats.');
            }
        }
    };
}

module.exports = statsHandlers;
