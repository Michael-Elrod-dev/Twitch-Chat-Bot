import type { QuoteRepository, QuoteRecord } from '../db/repositories/quoteRepository.js';

export interface QuoteManagerOptions {
    repository: QuoteRepository;
}

/** Per-channel quote book. Numbering restarts at 1 for every channel. */
export class QuoteManager {
    private readonly repository: QuoteRepository;

    constructor(options: QuoteManagerOptions) {
        this.repository = options.repository;
    }

    async count(): Promise<number> {
        return this.repository.count();
    }

    /** @returns the numbered quote, a random one when no number is given, or null. */
    async get(quoteNumber?: number): Promise<QuoteRecord | null> {
        if (quoteNumber === undefined) {
            return this.repository.getRandom();
        }
        if (!Number.isInteger(quoteNumber) || quoteNumber < 1) {
            return null;
        }
        return this.repository.getByNumber(quoteNumber);
    }

    /** @returns the number assigned to the new quote. */
    async add(quoteText: string, author: string | null, savedByTwitchUserId: string | null): Promise<number> {
        const text = quoteText.trim();
        if (text === '') {
            throw new Error('quote text is required');
        }
        return this.repository.add(text, author?.trim() || null, savedByTwitchUserId);
    }
}
