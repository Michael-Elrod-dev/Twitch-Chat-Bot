// src/commands/handlers/aiGames.js

const logger = require('../../logger/logger');

function aiGameHandlers() {
    return {
        async advice(twitchBot, channel, context, args) {
            try {
                const targetUsername = args[0]
                    ? args[0].replace('@', '').toLowerCase()
                    : context.username.toLowerCase();

                const targetUserResult = await twitchBot.analyticsManager.dbManager.query(
                    'SELECT user_id FROM viewers WHERE LOWER(username) = ?',
                    [targetUsername]
                );

                if (targetUserResult.length === 0) {
                    await twitchBot.sendMessage(channel, `@${context.username}, user ${targetUsername} not found!`);
                    return;
                }

                const targetUserId = targetUserResult[0].user_id;

                const result = await twitchBot.aiManager.handleGameCommand(
                    'advice',
                    targetUserId,
                    targetUsername,
                    twitchBot.currentStreamId,
                    {
                        userId: context['user-id'],
                        userName: context.username,
                        isBroadcaster: context.badges?.broadcaster || false,
                        isMod: context.mod || false
                    }
                );

                if (result.success) {
                    await twitchBot.sendMessage(channel, `@${targetUsername}, ${result.response}`);
                    logger.info('AIGameHandlers', 'Advice command executed', {
                        channel,
                        targetUsername,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `@${context.username}, ${result.message}`);
                }

            } catch (error) {
                logger.error('AIGameHandlers', 'Error in advice command', {
                    error: error.message,
                    stack: error.stack,
                    channel
                });
                await twitchBot.sendMessage(channel, 'Unable to generate advice right now.');
            }
        },

        async roast(twitchBot, channel, context, args) {
            try {
                const targetUsername = args[0]
                    ? args[0].replace('@', '').toLowerCase()
                    : context.username.toLowerCase();

                const targetUserResult = await twitchBot.analyticsManager.dbManager.query(
                    'SELECT user_id FROM viewers WHERE LOWER(username) = ?',
                    [targetUsername]
                );

                if (targetUserResult.length === 0) {
                    await twitchBot.sendMessage(channel, `@${context.username}, user ${targetUsername} not found!`);
                    return;
                }

                const targetUserId = targetUserResult[0].user_id;

                const result = await twitchBot.aiManager.handleGameCommand(
                    'roast',
                    targetUserId,
                    targetUsername,
                    twitchBot.currentStreamId,
                    {
                        userId: context['user-id'],
                        userName: context.username,
                        isBroadcaster: context.badges?.broadcaster || false,
                        isMod: context.mod || false
                    }
                );

                if (result.success) {
                    await twitchBot.sendMessage(channel, `@${targetUsername}, ${result.response}`);
                    logger.info('AIGameHandlers', 'Roast command executed', {
                        channel,
                        targetUsername,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `@${context.username}, ${result.message}`);
                }

            } catch (error) {
                logger.error('AIGameHandlers', 'Error in roast command', {
                    error: error.message,
                    stack: error.stack,
                    channel
                });
                await twitchBot.sendMessage(channel, 'Unable to generate roast right now.');
            }
        }
    };
}

module.exports = aiGameHandlers;
