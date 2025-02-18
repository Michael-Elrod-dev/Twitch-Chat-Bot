// src/redemptions/quotes/handleQuote.js
const QuoteManager = require('./quoteManager');

async function handleQuote(event, twitchBot, _, twitchBot2) {
    try {
        console.log('* Quote Redemption Detected:');
        console.log(`  User: ${event.userDisplayName}`);
        console.log(`  Input: ${event.input || 'No input provided'}`);

        const input = event.input.trim();
        
        if (!input) {
            await twitchBot.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await twitchBot.sendMessage(event.broadcasterDisplayName, 
                `@${event.userDisplayName} Please provide a quote in the format: 'Quote' - Person who said it. Your points have been refunded.`);
            return;
        }

        const match = input.match(/[''"](.*?)[''"]\s*-\s*(.*)/);
        
        if (!match) {
            await twitchBot.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await twitchBot.sendMessage(event.broadcasterDisplayName, 
                `@${event.userDisplayName} Invalid format. Please use: 'Quote' - Person who said it. Your points have been refunded.`);
            return;
        }

        const [, quote, author] = match;
        const quoteManager = new QuoteManager();
        
        const quoteData = {
            quote: quote.trim(),
            author: author.trim(),
            savedBy: event.userDisplayName
        };

        let quoteId;
        try {
            quoteId = quoteManager.addQuote(quoteData);
        } catch (saveError) {
            console.error('❌ Error saving quote:', saveError);
            await twitchBot.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await twitchBot.sendMessage(event.broadcasterDisplayName, 
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
            return;
        }

        await twitchBot.channelPoints.updateRedemptionStatusByIds(
            event.broadcasterId,
            event.rewardId,
            [event.id],
            'FULFILLED'
        );

        await twitchBot.sendMessage(event.broadcasterDisplayName, 
            `Quote #${quoteId} has been saved! "${quote.trim()}" - ${author.trim()}`);

    } catch (error) {
        console.error('❌ Error in quote handler:', error);
        try {
            await twitchBot.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await twitchBot.sendMessage(event.broadcasterDisplayName, 
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
        } catch (refundError) {
            console.error('❌ Error refunding points:', refundError);
        }
    }
}

module.exports = handleQuote;