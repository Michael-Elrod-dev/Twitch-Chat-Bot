import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { channels } from '../schema/channels.js';

export type ChannelStatus = 'active' | 'suspended' | 'disconnected' | 'needs_reauth';

export interface ChannelRecord {
    id: string;
    twitchBroadcasterId: string;
    twitchLogin: string;
    status: ChannelStatus;
}

export interface ChannelUpsert {
    twitchBroadcasterId: string;
    twitchLogin: string;
    displayName: string | null;
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

    /** By our own primary key — used when a credential already names the channel. */
    async findById(id: string): Promise<ChannelRecord | null> {
        const rows = await this.db
            .select({
                id: channels.id,
                twitchBroadcasterId: channels.twitchBroadcasterId,
                twitchLogin: channels.twitchLogin,
                status: channels.status
            })
            .from(channels)
            .where(eq(channels.id, id))
            .limit(1);

        return rows[0] ?? null;
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

    /**
     * Onboarding, idempotently.
     *
     * The unique index on `twitch_broadcaster_id` is what makes re-authorizing an
     * existing channel an update rather than a duplicate tenant — and it resets
     * the status, so reconnecting is how a `needs_reauth` channel recovers.
     */
    async upsert(channel: ChannelUpsert): Promise<ChannelRecord> {
        const [row] = await this.db
            .insert(channels)
            .values({
                twitchBroadcasterId: channel.twitchBroadcasterId,
                twitchLogin: channel.twitchLogin,
                displayName: channel.displayName,
                status: 'active'
            })
            .onConflictDoUpdate({
                target: channels.twitchBroadcasterId,
                set: {
                    twitchLogin: channel.twitchLogin,
                    displayName: channel.displayName,
                    status: 'active',
                    updatedAt: new Date()
                }
            })
            .returning({
                id: channels.id,
                twitchBroadcasterId: channels.twitchBroadcasterId,
                twitchLogin: channels.twitchLogin,
                status: channels.status
            });

        if (!row) throw new Error('channel upsert returned no row');
        return row;
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
