// src/commands/handlers/utility.js

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const logger = require('../../logger/logger');

function utilityHandlers() {
    return {
        async followAge(twitchBot, channel, context, args) {
            const toUser = args[0]?.replace('@', '') || context.username;

            logger.debug('UtilityHandlers', 'Fetching followage', {
                channel,
                toUser,
                requestedBy: context.username
            });

            try {
                const response = await fetch(`https://commands.garretcharp.com/twitch/followage/${channel}/${toUser}`);
                const followAge = await response.text();

                if (followAge.toLowerCase().includes('must login')) {
                    await twitchBot.sendMessage(channel, 'The channel owner needs to authenticate at https://commands.garretcharp.com/ to enable followage lookups.');
                    return;
                }

                await twitchBot.sendMessage(channel, followAge);
                logger.info('UtilityHandlers', 'Followage command executed', {
                    channel,
                    toUser,
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
