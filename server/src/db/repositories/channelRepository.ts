import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { channels } from '../schema/channels.js';

export type ChannelStatus = 'active' | 'suspended' | 'disconnected';

export interface ChannelRecord {
    id: string;
    twitchBroadcasterId: string;
    twitchLogin: string;
    status: ChannelStatus;
}

/**
 * The one repository that is deliberately NOT channel-scoped.
 *
 * `channels` is the tenancy root, so a repository bound to a single channel
 * could never enumerate it. Boot needs exactly this: the list of tenants to
 * bring up.
 */
export class ChannelRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    /** The channels the server should be listening to. */
    async listActive(): Promise<ChannelRecord[]> {
        const rows = await this.db
            .select({
                id: channels.id,
                twitchBroadcasterId: channels.twitchBroadcasterId,
                twitchLogin: channels.twitchLogin,
                status: channels.status
            })
            .from(channels)
            .where(eq(channels.status, 'active'));

        return rows;
    }

    async findByBroadcasterId(twitchBroadcasterId: string): Promise<ChannelRecord | null> {
        const rows = await this.db
            .select({
                id: channels.id,
                twitchBroadcasterId: channels.twitchBroadcasterId,
                twitchLogin: channels.twitchLogin,
                status: channels.status
            })
            .from(channels)
            .where(eq(channels.twitchBroadcasterId, twitchBroadcasterId))
            .limit(1);

        return rows[0] ?? null;
    }

    /** @returns whether a row was updated. */
    async setStatus(channelId: string, status: ChannelStatus): Promise<boolean> {
        const updated = await this.db
            .update(channels)
            .set({ status, updatedAt: new Date() })
            .where(eq(channels.id, channelId))
            .returning({ id: channels.id });

        return updated.length > 0;
    }
}
