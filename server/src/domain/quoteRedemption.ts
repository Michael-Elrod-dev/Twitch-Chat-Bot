import type { RedemptionHandler } from '../session/redemptionPipeline.js';
import type { QuoteRepository } from '../db/repositories/quoteRepository.js';
import type { Logger } from '../logger.js';

/**
 * `Add a quote`, with format validation and refund-on-malformed behavior.
 *
 * The format is strict on purpose. A quote is recalled later by number and
 * displayed verbatim, so a malformed one is a permanent piece of junk in the
 * channel's collection. Refusing it and giving the points back is better than
 * storing something nobody wants and cannot easily remove.
 */

/**
 * `"The quote" - Person`
 *
 * Accepts straight and curly quotes because a phone keyboard produces curly
 * ones and a viewer typing on their phone should not lose points for it. The
 * dash may be hyphen, en or em for the same reason.
 */
const QUOTE_PATTERN = /^\s*["“”'](.+?)["“”']\s*[-–—]\s*(.+?)\s*$/;

export const QUOTE_FORMAT_HELP =
    'Please use the format "Your quote here" - Person who said it. Your points have been refunded.';

export interface ParsedQuote {
    text: string;
    author: string;
}

/** @returns the parsed quote, or null when the input does not match. */
export function parseQuote(input: string): ParsedQuote | null {
    const match = QUOTE_PATTERN.exec(input);
    if (!match) return null;

    const text = (match[1] ?? '').trim();
    const author = (match[2] ?? '').trim();

    // A quote that is only whitespace inside its quotation marks matched the
    // shape but carries nothing.
    if (text === '' || author === '') return null;

    return { text, author };
}

export interface QuoteRedemptionOptions {
    quotes: QuoteRepository;
    logger: Logger;
}

export function createQuoteRedemptionHandler(options: QuoteRedemptionOptions): RedemptionHandler {
    return async (context) => {
        const input = context.event.userInput.trim();

        if (input === '') {
            return `You need to include the quote. ${QUOTE_FORMAT_HELP}`;
        }

        const parsed = parseQuote(input);
        if (!parsed) {
            return `Invalid format. ${QUOTE_FORMAT_HELP}`;
        }

        // A storage failure is a refund too: the viewer paid for a quote that
        // does not exist, and telling them otherwise would be a lie they
        // discover the next time they use !quote.
        const number = await options.quotes.add(
            parsed.text,
            parsed.author,
            context.event.redeemer.twitchUserId
        );

        options.logger.info(
            { channelId: context.channelId, quoteNumber: number, by: context.event.redeemer.login },
            'Quote added by redemption'
        );

        await context.reply(
            `@${context.event.redeemer.displayName} Quote #${number} added - "${parsed.text}" - ${parsed.author}`
        );

        return null;
    };
}
