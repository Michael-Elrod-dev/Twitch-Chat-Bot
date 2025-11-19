// src/commands/handlers/utility.js

const logger = require('../../logger/logger');

function utilityHandlers() {
    return {
        async followAge(twitchBot, channel, context, args) {
            const toUser = args[0]?.replace('@', '') || context.username;

            logger.debug('UtilityHandlers', 'Fetching followage from database', {
                channel,
                toUser,
                requestedBy: context.username
            });

            try {
                const sql = 'SELECT followed_at FROM viewers WHERE username = ?';
                const result = await twitchBot.analyticsManager.dbManager.query(sql, [toUser.toLowerCase()]);

                if (!result || result.length === 0 || !result[0].followed_at) {
                    await twitchBot.sendMessage(channel, `@${toUser} is not following this channel or follow data is not available.`);
                    logger.debug('UtilityHandlers', 'User not following or no follow data', { toUser });
                    return;
                }

                const followedAt = new Date(result[0].followed_at);
                const now = new Date();
                const diffMs = now - followedAt;

                const totalSeconds = Math.floor(diffMs / 1000);
                const totalMinutes = Math.floor(totalSeconds / 60);
                const totalHours = Math.floor(totalMinutes / 60);
                const totalDays = Math.floor(totalHours / 24);

                const years = Math.floor(totalDays / 365);
                const days = totalDays % 365;
                const hours = totalHours % 24;
                const minutes = totalMinutes % 60;
                const seconds = totalSeconds % 60;

                const formattedDate = `${String(followedAt.getMonth() + 1).padStart(2, '0')}/${String(followedAt.getDate()).padStart(2, '0')}/${String(followedAt.getFullYear()).slice(-2)}`;

                let timeParts = [];
                if (years > 0) timeParts.push(`${years} year${years !== 1 ? 's' : ''}`);
                if (days > 0) timeParts.push(`${days} day${days !== 1 ? 's' : ''}`);
                if (hours > 0) timeParts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
                if (minutes > 0) timeParts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
                if (seconds > 0 || timeParts.length === 0) timeParts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);

                const timeAgoStr = timeParts.join(', ');

                await twitchBot.sendMessage(channel, `@${toUser} followed on ${formattedDate}. ${timeAgoStr} ago.`);
                logger.info('UtilityHandlers', 'Followage command executed', {
                    channel,
                    toUser,
                    followedAt: formattedDate,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('UtilityHandlers', 'Error fetching follow data', { error: error.message, stack: error.stack, channel, toUser });
                await twitchBot.sendMessage(channel, `Error: ${error.message || 'Unable to fetch follow data'}`);
            }
        },

        async uptime(twitchBot, channel, context) {
            try {
                const stream = await twitchBot.streams.getStreamByUserName(channel);

                if (stream) {
                    const startTime = new Date(stream.startDate);
                    const now = new Date();
                    const diffMs = now - startTime;

                    const hours = Math.floor(diffMs / 3600000);
                    const minutes = Math.floor((diffMs % 3600000) / 60000);

                    let uptimeStr = '';
                    if (hours > 0) uptimeStr += `${hours} hour${hours !== 1 ? 's' : ''} `;
                    if (minutes > 0 || hours === 0) uptimeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`;

                    await twitchBot.sendMessage(channel, `Stream has been live for ${uptimeStr.trim()}`);
                    logger.info('UtilityHandlers', 'Uptime command executed', {
                        channel,
                        uptimeMs: diffMs,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `${channel} is not live`);
                    logger.debug('UtilityHandlers', 'Uptime checked - stream not live', { channel });
                }
            } catch (error) {
                logger.error('UtilityHandlers', 'Uptime fetch failed', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'A fix for this command is coming soon.');
            }
        }
    };
}

module.exports = utilityHandlers;
