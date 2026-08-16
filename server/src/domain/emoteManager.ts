import type { CacheManager } from '../cache/cacheManager.js';
import { CacheKeys } from '../cache/keys.js';
import type { EmoteRepository } from '../db/repositories/emoteRepository.js';

const CACHE_TTL_SECONDS = 300;

export interface EmoteManagerOptions {
    channelId: string;
    repository: EmoteRepository;
    cache: CacheManager;
}

/**
 * Exact-match trigger/response, per channel.
 *
 * Every non-matching chat message reaches this lookup, so the miss path is the
 * hot path - hence the same populated-hash discipline as commands.
 */
export class EmoteManager {
    private readonly channelId: string;
    private readonly repository: EmoteRepository;
    private readonly cache: CacheManager;

    private emotes = new Map<string, string>();
    private loaded = false;

    constructor(options: EmoteManagerOptions) {
        this.channelId = options.channelId;
        this.repository = options.repository;
        this.cache = options.cache;
    }

    async load(): Promise<void> {
        const rows = await this.repository.listAll();
        this.emotes = new Map(rows.map((r) => [r.triggerText.toLowerCase(), r.responseText]));
        this.loaded = true;

        await this.cache.replaceHash(
            CacheKeys.emotes(this.channelId),
            Object.fromEntries(this.emotes),
            CACHE_TTL_SECONDS
        );
    }

    /** @returns the response for an exact trigger match, or null. */
    async match(text: string): Promise<string | null> {
        const normalized = text.trim().toLowerCase();
        if (normalized === '') return null;

        const cached = await this.cache.getHashField<string>(CacheKeys.emotes(this.channelId), normalized);
        if (cached.hit) return cached.value;
        if (cached.populated) return null;

        if (!this.loaded) await this.load();
        return this.emotes.get(normalized) ?? null;
    }

    async add(triggerText: string, responseText: string): Promise<void> {
        await this.repository.create({ triggerText, responseText });
        await this.load();
    }

    async remove(triggerText: string): Promise<boolean> {
        const removed = await this.repository.delete(triggerText);
        if (removed) await this.load();
        return removed;
    }
}
