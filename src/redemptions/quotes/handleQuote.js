// src/redemptions/quotes/handleQuote.js
const QuoteManager = require('./quoteManager');

async function handleQuote(event, client, _, apiClient) {
    try {
        console.log('* Quote Redemption Detected:');
        console.log(`  User: ${event.userDisplayName}`);
        console.log(`  Input: ${event.input || 'No input provided'}`);

        const input = event.input.trim();
        
        if (!input) {
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
                `@${event.userDisplayName} Please provide a quote in the format: 'Quote' - Person who said it. Your points have been refunded.`);
            return;
        }

        const match = input.match(/[''"](.*?)[''"]\s*-\s*(.*)/);
        
        if (!match) {
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
                `@${event.userDisplayName} Invalid format. Please use: 'Quote' - Person who said it. Your points have been refunded.`);
            return;
        }

        const [, quote, author] = match;
        const quoteManager = new QuoteManager();
        
        // Store quote data before saving
        const quoteData = {
            quote: quote.trim(),
            author: author.trim(),
            savedBy: event.userDisplayName
        };

        // Try to save the quote
        let quoteId;
        try {
            quoteId = quoteManager.addQuote(quoteData);
        } catch (saveError) {
            console.error('Error saving quote:', saveError);
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
            return;
        }

        // Only mark as fulfilled and send success message if everything worked
        await apiClient.channelPoints.updateRedemptionStatusByIds(
            event.broadcasterId,
            event.rewardId,
            [event.id],
            'FULFILLED'
        );

        await client.say(`#${event.broadcasterDisplayName}`, 
            `Quote #${quoteId} has been saved! "${quote.trim()}" - ${author.trim()}`);

    } catch (error) {
        console.error('Error in quote handler:', error);
        try {
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
                `@${event.userDisplayName} Sorry, there was an error saving your quote. Your points have been refunded.`);
        } catch (refundError) {
            console.error('Error refunding points:', refundError);
        }
    }
}

module.exports = handleQuote;