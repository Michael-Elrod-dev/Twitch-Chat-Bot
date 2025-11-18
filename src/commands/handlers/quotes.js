// src/commands/handlers/quotes.js

const logger = require('../../logger/logger');

function quoteHandlers(dependencies) {
    const { quoteManager } = dependencies;

    return {
        async quoteHandler(twitchBot, channel, context, args) {
            try {
                if (!quoteManager.dbManager) {
                    await quoteManager.init(twitchBot.analyticsManager.dbManager);
                }

                const totalQuotes = await quoteManager.getTotalQuotes();

                if (totalQuotes === 0) {
                    await twitchBot.sendMessage(channel, 'No quotes saved yet!');
                    return;
                }

                let quote;
                if (args.length > 0 && !isNaN(args[0])) {
                    const id = parseInt(args[0]);
                    quote = await quoteManager.getQuoteById(id);

                    if (!quote) {
                        await twitchBot.sendMessage(channel, `Quote #${id} not found!`);
                        logger.debug('QuoteHandlers', 'Quote not found', { channel, quoteId: id });
                        return;
                    }
                } else {
                    quote = await quoteManager.getRandomQuote();
                }

                const year = new Date(quote.savedAt).getFullYear();
                await twitchBot.sendMessage(channel, `Quote #${quote.id}/${totalQuotes} - '${quote.quote}' - ${quote.author}, ${year}`);
                logger.info('QuoteHandlers', 'Quote command executed', {
                    channel,
                    quoteId: quote.id,
                    totalQuotes,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('QuoteHandlers', 'Error in quote handler', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Sorry, there was an error retrieving quotes.');
            }
        }
    };
}

module.exports = quoteHandlers;
