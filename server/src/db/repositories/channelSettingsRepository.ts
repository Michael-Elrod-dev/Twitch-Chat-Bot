import { eq } from 'drizzle-orm';
import { channelSettings } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface ChannelSettingsRecord {
    aiEnabled: boolean;
    songRequestsEnabled: boolean;
    discordWebhookUrl: string | null;
    /** See the schema: the requests-playlist feature, foundation shipped in P1-WP4.3. */
    requestsPlaylistEnabled: boolean;
    requestsPlaylistName: string | null;
    requestsPlaylistId: string | null;
}

export class ChannelSettingsRepository extends ChannelScopedRepository {
    async get(): Promise<ChannelSettingsRecord | null> {
        const [row] = await this.db
            .select({
                aiEnabled: channelSettings.aiEnabled,
                songRequestsEnabled: channelSettings.songRequestsEnabled,
                discordWebhookUrl: channelSettings.discordWebhookUrl,
                requestsPlaylistEnabled: channelSettings.requestsPlaylistEnabled,
                requestsPlaylistName: channelSettings.requestsPlaylistName,
                requestsPlaylistId: channelSettings.requestsPlaylistId
            })
            .from(channelSettings)
            .where(eq(channelSettings.channelId, this.channelId));

        return row ?? null;
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
