import type { Database } from '../client.js';

/**
 * Every repository is bound to one channel at construction. A repository
 * therefore *cannot* read or write another tenant's rows - isolation is a
 * property of the type, not of remembering to add a WHERE clause.
 */
export abstract class ChannelScopedRepository {
    protected readonly db: Database;
    protected readonly channelId: string;

    constructor(db: Database, channelId: string) {
        this.db = db;
        this.channelId = channelId;
    }
}
