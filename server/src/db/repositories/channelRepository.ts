import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { channels } from '../schema/channels.js';

export type ChannelStatus = 'active' | 'suspended' | 'disconnected' | 'needs_reauth';

export interface ChannelRecord {
    id: string;
    twitchBroadcasterId: string;
    twitchLogin: string;
    /** What the world did to this channel. */
    status: ChannelStatus;
    /** What the owner chose. Never derived from, or folded into, `status`. */
    enabled: boolean;
}

/**
 * The columns every read of this table returns.
 *
 * Written once so a new column cannot reach some callers and not others. That
 * kind of drift is what makes `enabled` look absent on exactly the code path
 * that decides whether to start a session.
 */
const CHANNEL_COLUMNS = {
    id: channels.id,
    twitchBroadcasterId: channels.twitchBroadcasterId,
    twitchLogin: channels.twitchLogin,
    status: channels.status,
    enabled: channels.enabled
} as const;

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

    /**
     * The channels the server should be listening to.
     *
     * Both conditions, because both have to hold: Twitch must still permit it
     * (`status = 'active'`) AND the owner must still want it (`enabled`).
     * Leaving `enabled` out here would let a paused bot come back on at the next
     * restart, which is the failure the switch exists to prevent.
     */
    async listActive(): Promise<ChannelRecord[]> {
        const rows = await this.db
            .select(CHANNEL_COLUMNS)
            .from(channels)
            .where(and(eq(channels.status, 'active'), eq(channels.enabled, true)));

        return rows;
    }

    /** By this table's own primary key, for when a credential already names the channel. */
    async findById(id: string): Promise<ChannelRecord | null> {
        const rows = await this.db
            .select(CHANNEL_COLUMNS)
            .from(channels)
            .where(eq(channels.id, id))
            .limit(1);

        return rows[0] ?? null;
    }

    async findByBroadcasterId(twitchBroadcasterId: string): Promise<ChannelRecord | null> {
        const rows = await this.db
            .select(CHANNEL_COLUMNS)
            .from(channels)
            .where(eq(channels.twitchBroadcasterId, twitchBroadcasterId))
            .limit(1);

        return rows[0] ?? null;
    }

    /**
     * Onboarding, idempotently.
     *
     * The unique index on `twitch_broadcaster_id` is what makes re-authorizing an
     * existing channel an update rather than a duplicate tenant. It also resets
     * the status, so reconnecting is how a `needs_reauth` channel recovers.
     *
     * It deliberately does NOT touch `enabled`. Re-authorizing with Twitch says
     * nothing about whether the broadcaster wants the bot running; silently
     * flipping their switch back on because they fixed an unrelated problem
     * would be the app overriding a choice they made on purpose.
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
            .returning(CHANNEL_COLUMNS);

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

    /**
     * Flips the owner's master switch.
     *
     * Writes `enabled` and nothing else, in particular not `status`, which
     * belongs to Twitch and to administration. Returns the row as it now
     * stands so the caller can report both fields from one round trip without
     * assuming what the other one is.
     */
    async setEnabled(channelId: string, enabled: boolean): Promise<ChannelRecord | null> {
        const updated = await this.db
            .update(channels)
            .set({ enabled, updatedAt: new Date() })
            .where(eq(channels.id, channelId))
            .returning(CHANNEL_COLUMNS);

        return updated[0] ?? null;
    }
}
