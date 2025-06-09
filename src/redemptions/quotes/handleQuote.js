// src/redemptions/quotes/handleQuote.js
async function handleQuote(event, twitchBot, _, twitchBot2) {
    try {
        const input = event.input.trim();
        
        if (!input) {
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

        const match = input.match(/[''"](.*?)[''"]\s*-\s*(.*)/);
        
        if (!match) {
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
            console.error('❌ Error saving quote:', saveError);
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

        await twitchBot.sendMessage(event.broadcasterDisplayName, 
            `Quote #${quoteId} has been saved! "${quote.trim()}" - ${author.trim()}`);

    } catch (error) {
        console.error('❌ Error in quote handler:', error);
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
            console.error('❌ Error refunding points:', refundError);
        }
    }
}

module.exports = handleQuote;