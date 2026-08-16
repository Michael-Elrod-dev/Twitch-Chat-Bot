import type { Database } from '../client.js';
import { botIdentity } from '../schema/channels.js';

export interface BotIdentityRecord {
    twitchUserId: string;
    twitchLogin: string;
}

/**
 * The shared bot account.
 *
 * One row, by design (owner decision §8.5): a single bot identity reads and
 * writes chat in every channel, which is Twitch's own documented pattern for
 * this architecture. Not channel-scoped, because it is not per-channel data.
 */
export class BotIdentityRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async get(): Promise<BotIdentityRecord | null> {
        const rows = await this.db
            .select({ twitchUserId: botIdentity.twitchUserId, twitchLogin: botIdentity.twitchLogin })
            .from(botIdentity)
            .limit(1);

        return rows[0] ?? null;
    }
}
