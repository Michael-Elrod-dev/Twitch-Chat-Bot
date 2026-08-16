import { and, eq, sql as raw } from 'drizzle-orm';
import { quotes, channels } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface QuoteRecord {
    quoteNumber: number;
    quoteText: string;
    author: string | null;
}

export class QuoteRepository extends ChannelScopedRepository {
    async count(): Promise<number> {
        const [row] = await this.db
            .select({ count: raw<number>`count(*)::int` })
            .from(quotes)
            .where(eq(quotes.channelId, this.channelId));

        return row?.count ?? 0;
    }

    async getByNumber(quoteNumber: number): Promise<QuoteRecord | null> {
        const [row] = await this.db
            .select({ quoteNumber: quotes.quoteNumber, quoteText: quotes.quoteText, author: quotes.author })
            .from(quotes)
            .where(and(eq(quotes.channelId, this.channelId), eq(quotes.quoteNumber, quoteNumber)));

        return row ?? null;
    }

    async getRandom(): Promise<QuoteRecord | null> {
        const [row] = await this.db
            .select({ quoteNumber: quotes.quoteNumber, quoteText: quotes.quoteText, author: quotes.author })
            .from(quotes)
            .where(eq(quotes.channelId, this.channelId))
            .orderBy(raw`random()`)
            .limit(1);

        return row ?? null;
    }

    /**
     * Appends a quote, allocating the next per-channel number.
     *
     * The read-then-insert runs in one transaction with a row lock, so two
     * concurrent saves cannot claim the same number - the Phase-0 P1-8 lesson,
     * applied to the equivalent shape here.
     */
    async add(quoteText: string, author: string | null, savedByTwitchUserId: string | null): Promise<number> {
        return this.db.transaction(async (tx) => {
            // Postgres refuses FOR UPDATE alongside an aggregate, so the lock goes
            // on the parent channel row instead. That serialises quote allocation
            // per channel - which is exactly the scope that needs it - and leaves
            // other channels free to insert concurrently.
            await tx
                .select({ id: channels.id })
                .from(channels)
                .where(eq(channels.id, this.channelId))
                .for('update');

            const [row] = await tx
                .select({ next: raw<number>`coalesce(max(${quotes.quoteNumber}), 0) + 1` })
                .from(quotes)
                .where(eq(quotes.channelId, this.channelId));

            const quoteNumber = row?.next ?? 1;

            await tx.insert(quotes).values({
                channelId: this.channelId,
                quoteNumber,
                quoteText,
                author,
                savedByTwitchUserId
            });

            return quoteNumber;
        });
    }
}
