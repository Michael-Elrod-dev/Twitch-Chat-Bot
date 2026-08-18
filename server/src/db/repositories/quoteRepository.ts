import { and, desc, eq, sql as raw } from 'drizzle-orm';
import { quotes, channels, viewers } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface QuoteRecord {
    quoteNumber: number;
    quoteText: string;
    author: string | null;
    /** When it was saved. `!quote` prints the year, as Phase 0 did. */
    savedAt: Date;
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
            .select({
                quoteNumber: quotes.quoteNumber,
                quoteText: quotes.quoteText,
                author: quotes.author,
                savedAt: quotes.savedAt
            })
            .from(quotes)
            .where(and(eq(quotes.channelId, this.channelId), eq(quotes.quoteNumber, quoteNumber)));

        return row ?? null;
    }

    async getRandom(): Promise<QuoteRecord | null> {
        const [row] = await this.db
            .select({
                quoteNumber: quotes.quoteNumber,
                quoteText: quotes.quoteText,
                author: quotes.author,
                savedAt: quotes.savedAt
            })
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
            /*
             * `saved_by_twitch_user_id` references `viewers` with RESTRICT, so
             * it can only name someone the system has actually seen. A quote
             * saved from the dashboard may come from an account that has never
             * chatted here — the broadcaster's own, on a fresh channel — and
             * attributing it would violate the constraint and fail the write.
             *
             * Null is not data loss in that case, it is the accurate answer:
             * there is no viewer record to point at. The chat `!quote` path
             * always passes a chatter, who by definition exists.
             */
            let savedBy = savedByTwitchUserId;
            if (savedBy !== null) {
                const [known] = await tx
                    .select({ id: viewers.twitchUserId })
                    .from(viewers)
                    .where(eq(viewers.twitchUserId, savedBy))
                    .limit(1);
                if (!known) savedBy = null;
            }

            // Postgres refuses FOR UPDATE alongside an aggregate, so the lock goes
            // on the parent channel row instead. That serializes quote allocation
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
                savedByTwitchUserId: savedBy
            });

            return quoteNumber;
        });
    }

    /** Newest first, which is what a management UI wants by default. */
    async list(limit: number, offset: number): Promise<QuoteRecord[]> {
        return this.db
            .select({
                quoteNumber: quotes.quoteNumber,
                quoteText: quotes.quoteText,
                author: quotes.author,
                savedAt: quotes.savedAt
            })
            .from(quotes)
            .where(eq(quotes.channelId, this.channelId))
            .orderBy(desc(quotes.quoteNumber))
            .limit(limit)
            .offset(offset);
    }

    /**
     * Deletes by number.
     *
     * Numbers are deliberately NOT reissued afterwards: a quote is referred to
     * by its number in chat and in clips, so renumbering would silently change
     * what an old reference points at.
     */
    async deleteByNumber(quoteNumber: number): Promise<boolean> {
        const removed = await this.db
            .delete(quotes)
            .where(and(eq(quotes.channelId, this.channelId), eq(quotes.quoteNumber, quoteNumber)))
            .returning({ id: quotes.id });

        return removed.length > 0;
    }

}
