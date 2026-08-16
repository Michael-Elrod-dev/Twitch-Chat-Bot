import type { Logger } from '../logger.js';
import type { CacheManager } from '../cache/cacheManager.js';
import { CacheKeys } from '../cache/keys.js';
import type {
    ChannelSettingsRepository,
    ChannelSettingsRecord
} from '../db/repositories/channelSettingsRepository.js';

const CACHE_TTL_SECONDS = 60;

const DEFAULTS: ChannelSettingsRecord = {
    aiEnabled: true,
    songRequestsEnabled: true,
    discordWebhookUrl: null
};

export interface SettingsServiceOptions {
    channelId: string;
    repository: ChannelSettingsRepository;
    cache: CacheManager;
    logger: Logger;
}

/** Per-channel behaviour knobs, replacing Phase 0's key/value drawer. */
export class SettingsService {
    private readonly channelId: string;
    private readonly repository: ChannelSettingsRepository;
    private readonly cache: CacheManager;
    private readonly logger: Logger;

    constructor(options: SettingsServiceOptions) {
        this.channelId = options.channelId;
        this.repository = options.repository;
        this.cache = options.cache;
        this.logger = options.logger;
    }

    async get(): Promise<ChannelSettingsRecord> {
        const cached = await this.cache.getJson<ChannelSettingsRecord>(CacheKeys.settings(this.channelId));
        if (cached) return cached;

        const stored = (await this.repository.get()) ?? DEFAULTS;
        await this.cache.setJson(CacheKeys.settings(this.channelId), stored, CACHE_TTL_SECONDS);
        return stored;
    }

    /**
     * Fails CLOSED. If the flag cannot be read, the AI stays quiet rather than
     * resurrecting one the broadcaster deliberately switched off (Phase 0 WP-6
     * task 6, a deliberate behaviour change carried forward).
     */
    async isAiEnabled(): Promise<boolean> {
        try {
            return (await this.get()).aiEnabled;
        } catch (err) {
            this.logger.error(
                { channelId: this.channelId, err: (err as Error).message },
                'Could not read AI setting - treating AI as disabled'
            );
            return false;
        }
    }

    /** Invalidates the cache on write, so a toggle takes effect immediately. */
    async setAiEnabled(enabled: boolean): Promise<void> {
        await this.repository.setAiEnabled(enabled);
        await this.cache.del(CacheKeys.settings(this.channelId));
    }
}
