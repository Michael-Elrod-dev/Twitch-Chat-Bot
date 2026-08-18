import { eq } from 'drizzle-orm';
import { channelSettings } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

/** The four editable tiers. The broadcaster is unlimited and is not stored. */
export interface AiLimitsRecord {
    everyone: number;
    vip: number;
    subscriber: number;
    moderator: number;
}

export interface ChannelSettingsRecord {
    aiEnabled: boolean;
    aiLimits: AiLimitsRecord;
    songRequestsEnabled: boolean;
    discordWebhookUrl: string | null;
    /** The requests-playlist feature. The schema carries the detail. */
    requestsPlaylistEnabled: boolean;
    requestsPlaylistName: string | null;
    requestsPlaylistId: string | null;
}

export class ChannelSettingsRepository extends ChannelScopedRepository {
    async get(): Promise<ChannelSettingsRecord | null> {
        const [row] = await this.db
            .select({
                aiEnabled: channelSettings.aiEnabled,
                aiLimitEveryone: channelSettings.aiLimitEveryone,
                aiLimitVip: channelSettings.aiLimitVip,
                aiLimitSubscriber: channelSettings.aiLimitSubscriber,
                aiLimitModerator: channelSettings.aiLimitModerator,
                songRequestsEnabled: channelSettings.songRequestsEnabled,
                discordWebhookUrl: channelSettings.discordWebhookUrl,
                requestsPlaylistEnabled: channelSettings.requestsPlaylistEnabled,
                requestsPlaylistName: channelSettings.requestsPlaylistName,
                requestsPlaylistId: channelSettings.requestsPlaylistId
            })
            .from(channelSettings)
            .where(eq(channelSettings.channelId, this.channelId));

        if (!row) return null;

        // Four flat columns become one nested object here rather than at every
        // reader: the limits travel together everywhere they are used, and a
        // shape that matches the contract is one fewer place to reassemble it.
        return {
            aiEnabled: row.aiEnabled,
            aiLimits: {
                everyone: row.aiLimitEveryone,
                vip: row.aiLimitVip,
                subscriber: row.aiLimitSubscriber,
                moderator: row.aiLimitModerator
            },
            songRequestsEnabled: row.songRequestsEnabled,
            discordWebhookUrl: row.discordWebhookUrl,
            requestsPlaylistEnabled: row.requestsPlaylistEnabled,
            requestsPlaylistName: row.requestsPlaylistName,
            requestsPlaylistId: row.requestsPlaylistId
        };
    }

    async setAiEnabled(enabled: boolean): Promise<void> {
        await this.db
            .insert(channelSettings)
            .values({ channelId: this.channelId, aiEnabled: enabled })
            .onConflictDoUpdate({
                target: channelSettings.channelId,
                set: { aiEnabled: enabled, updatedAt: new Date() }
            });
    }

    /**
     * Partial update.
     *
     * Only keys actually present are written, so a PATCH that mentions one
     * setting cannot silently reset the others to their defaults - the failure
     * mode of building an update from a fully-defaulted object.
     */
    async update(patch: Partial<ChannelSettingsRecord>): Promise<void> {
        const changes: Record<string, unknown> = {};
        if (patch.aiEnabled !== undefined) changes['aiEnabled'] = patch.aiEnabled;
        if (patch.aiLimits !== undefined) {
            // All four or none. A partial set would have to be merged against a
            // read, and two edits in flight would resolve to whichever landed
            // second, with the other tier's change lost inside a write that
            // never mentioned it.
            changes['aiLimitEveryone'] = patch.aiLimits.everyone;
            changes['aiLimitVip'] = patch.aiLimits.vip;
            changes['aiLimitSubscriber'] = patch.aiLimits.subscriber;
            changes['aiLimitModerator'] = patch.aiLimits.moderator;
        }
        if (patch.songRequestsEnabled !== undefined) changes['songRequestsEnabled'] = patch.songRequestsEnabled;
        if (patch.discordWebhookUrl !== undefined) changes['discordWebhookUrl'] = patch.discordWebhookUrl;
        if (patch.requestsPlaylistEnabled !== undefined) {
            changes['requestsPlaylistEnabled'] = patch.requestsPlaylistEnabled;
        }
        if (patch.requestsPlaylistName !== undefined) changes['requestsPlaylistName'] = patch.requestsPlaylistName;
        if (patch.requestsPlaylistId !== undefined) changes['requestsPlaylistId'] = patch.requestsPlaylistId;

        if (Object.keys(changes).length === 0) return;

        await this.db
            .insert(channelSettings)
            .values({ channelId: this.channelId, ...changes })
            .onConflictDoUpdate({
                target: channelSettings.channelId,
                set: { ...changes, updatedAt: new Date() }
            });
    }

}
