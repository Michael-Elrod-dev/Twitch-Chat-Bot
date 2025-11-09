// src/redemptions/quotes/handleQuote.js

const logger = require('../../logger/logger');

async function handleQuote(event, twitchBot) {
    try {
        const input = event.input.trim();

        if (!input) {
            logger.info('HandleQuote', 'Quote redemption cancelled: No input provided', {
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );

            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Please provide a quote in the format: "Quote" - Person who said it. Your points have been refunded.`);
            return;
        }

        // Match quotes with various quote characters (straight and curly quotes)
        const match = input.match(/['"\u2018\u2019\u201C\u201D](.*?)['"\u2018\u2019\u201C\u201D]\s*-\s*(.*)/);

        if (!match) {
            logger.info('HandleQuote', 'Quote redemption cancelled: Invalid format', {
                userId: event.userId,
                userDisplayName: event.userDisplayName,
                input: input
            });
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );

            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Invalid format. Please use: "Quote" - Person who said it. Your points have been refunded.`);
            return;
        }

        const [, quote, author] = match;

        if (!twitchBot.quoteManager.dbManager) {
            await twitchBot.quoteManager.init(twitchBot.analyticsManager.dbManager);
        }

        const quoteData = {
            quote: quote.trim(),
            author: author.trim(),
            savedBy: event.userDisplayName,
            userId: event.userId
        };

        let quoteId;
        try {
            quoteId = await twitchBot.quoteManager.addQuote(quoteData);
        } catch (saveError) {
            logger.error('HandleQuote', 'Error saving quote', {
                error: saveError.message,
                stack: saveError.stack,
                quote: quoteData.quote,
                author: quoteData.author,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );

            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
            return;
        }

        await twitchBot.redemptionManager.updateRedemptionStatus(
            event.broadcasterId,
            event.rewardId,
            [event.id],
            'FULFILLED'
        );

        logger.info('HandleQuote', 'Quote saved and redemption fulfilled', {
            quoteId,
            quote: quote.trim(),
            author: author.trim(),
            savedBy: event.userDisplayName,
            userId: event.userId
        });

        await twitchBot.sendMessage(event.broadcasterDisplayName,
            `Quote #${quoteId} has been saved! "${quote.trim()}" - ${author.trim()}`);

    } catch (error) {
        logger.error('HandleQuote', 'Error in quote handler', {
            error: error.message,
            stack: error.stack,
            userId: event.userId,
            userDisplayName: event.userDisplayName,
            input: event.input
        });
        try {
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );

            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
        } catch (refundError) {
            logger.error('HandleQuote', 'Error refunding points', {
                error: refundError.message,
                stack: refundError.stack,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
        }
    }
}

module.exports = handleQuote;
