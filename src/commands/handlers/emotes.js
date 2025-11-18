// src/commands/handlers/emotes.js

const logger = require('../../logger/logger');

/**
 * Emote management command handlers
 */
function emoteHandlers() {
    return {
        async emoteAdd(twitchBot, channel, context, args) {
            if (!context.mod && !context.badges?.broadcaster) return;

            if (args.length < 2) {
                await twitchBot.sendMessage(channel, 'Usage: !emoteadd <trigger> <response>');
                return;
            }

            const trigger = args[0].toLowerCase();
            const response = args.slice(1).join(' ');

            try {
                const success = await twitchBot.emoteManager.addEmote(trigger, response);
                if (success) {
                    await twitchBot.sendMessage(channel, `Emote "${trigger}" added successfully!`);
                    logger.info('EmoteHandlers', 'Emote added', {
                        channel,
                        trigger,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `Emote "${trigger}" already exists.`);
                    logger.debug('EmoteHandlers', 'Emote already exists', {
                        channel,
                        trigger
                    });
                }
            } catch (error) {
                logger.error('EmoteHandlers', 'Error adding emote', {
                    error: error.message,
                    stack: error.stack,
                    channel,
                    trigger
                });
                await twitchBot.sendMessage(channel, 'Error adding emote.');
            }
        }
    };
}

module.exports = emoteHandlers;
