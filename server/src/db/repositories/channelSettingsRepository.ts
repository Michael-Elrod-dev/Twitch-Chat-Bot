import { eq } from 'drizzle-orm';
import { channelSettings } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';

export interface ChannelSettingsRecord {
    aiEnabled: boolean;
    songRequestsEnabled: boolean;
    discordWebhookUrl: string | null;
}

export class ChannelSettingsRepository extends ChannelScopedRepository {
    async get(): Promise<ChannelSettingsRecord | null> {
        const [row] = await this.db
            .select({
                aiEnabled: channelSettings.aiEnabled,
                songRequestsEnabled: channelSettings.songRequestsEnabled,
                discordWebhookUrl: channelSettings.discordWebhookUrl
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
}
