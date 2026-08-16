import { and, eq } from 'drizzle-orm';
import { emotes } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface EmoteRecord {
    triggerText: string;
    responseText: string;
}

export class EmoteRepository extends ChannelScopedRepository {
    async listAll(): Promise<EmoteRecord[]> {
        return this.db
            .select({ triggerText: emotes.triggerText, responseText: emotes.responseText })
            .from(emotes)
            .where(eq(emotes.channelId, this.channelId));
    }

    async create(record: EmoteRecord): Promise<void> {
        await this.db.insert(emotes).values({
            channelId: this.channelId,
            triggerText: record.triggerText.toLowerCase(),
            responseText: record.responseText
        });
    }

    async delete(triggerText: string): Promise<boolean> {
        const deleted = await this.db
            .delete(emotes)
            .where(and(eq(emotes.channelId, this.channelId), eq(emotes.triggerText, triggerText.toLowerCase())))
            .returning({ triggerText: emotes.triggerText });

        return deleted.length > 0;
    }
}
