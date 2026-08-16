import { and, eq } from 'drizzle-orm';
import { channelRoles, viewers } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface ChannelRoleRecord {
    isModerator: boolean;
    isVip: boolean;
    isSubscriber: boolean;
    isBroadcaster: boolean;
}

export class ChannelRoleRepository extends ChannelScopedRepository {
    async get(twitchUserId: string): Promise<ChannelRoleRecord | null> {
        const [row] = await this.db
            .select({
                isModerator: channelRoles.isModerator,
                isVip: channelRoles.isVip,
                isSubscriber: channelRoles.isSubscriber,
                isBroadcaster: channelRoles.isBroadcaster
            })
            .from(channelRoles)
            .where(and(eq(channelRoles.channelId, this.channelId), eq(channelRoles.twitchUserId, twitchUserId)));

        return row ?? null;
    }

    /**
     * Records roles observed on a chat message.
     *
     * Only ever called from a path that genuinely knows the roles. Phase 0's
     * P1-1 was a poll that wrote default-false roles once a minute and wiped
     * everything the chat path had learned; the equivalent presence-touch path
     * lives in `touchPresence` and deliberately writes no role columns.
     */
    async upsertRoles(twitchUserId: string, login: string, roles: ChannelRoleRecord): Promise<void> {
        await this.db
            .insert(viewers)
            .values({ twitchUserId, login })
            .onConflictDoUpdate({ target: viewers.twitchUserId, set: { login, updatedAt: new Date() } });

        await this.db
            .insert(channelRoles)
            .values({ channelId: this.channelId, twitchUserId, ...roles, lastSeenAt: new Date() })
            .onConflictDoUpdate({
                target: [channelRoles.channelId, channelRoles.twitchUserId],
                set: { ...roles, lastSeenAt: new Date(), updatedAt: new Date() }
            });
    }

    /** Presence only - never touches role columns. See upsertRoles. */
    async touchPresence(twitchUserId: string, login: string): Promise<void> {
        await this.db
            .insert(viewers)
            .values({ twitchUserId, login })
            .onConflictDoUpdate({ target: viewers.twitchUserId, set: { login, updatedAt: new Date() } });

        await this.db
            .insert(channelRoles)
            .values({ channelId: this.channelId, twitchUserId, lastSeenAt: new Date() })
            .onConflictDoUpdate({
                target: [channelRoles.channelId, channelRoles.twitchUserId],
                set: { lastSeenAt: new Date(), updatedAt: new Date() }
            });
    }
}
