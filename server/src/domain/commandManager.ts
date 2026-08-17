import type { Logger } from '../logger.js';
import type { CacheManager } from '../cache/cacheManager.js';
import { CacheKeys } from '../cache/keys.js';
import type { CommandRepository, CommandRecord } from '../db/repositories/commandRepository.js';
import { hasPermission, isUserLevel, type ChatterRoles, type UserLevel } from './permissions.js';
import type { HandlerRegistry } from './handlers.js';

const CACHE_TTL_SECONDS = 300;

export interface CommandLookup {
    name: string;
    responseText: string | null;
    handlerName: string | null;
    description: string | null;
    userLevel: UserLevel;
}

export interface CommandManagerOptions {
    channelId: string;
    repository: CommandRepository;
    cache: CacheManager;
    logger: Logger;
    handlers?: HandlerRegistry;
}

/**
 * Per-channel command registry.
 *
 * Three Phase-0 lessons are load-bearing here and each is pinned by a test:
 *  - permission is enforced in exactly one place (WP-6 task 9),
 *  - a handler's declared level beats the database row, and the row is corrected
 *    at load so the table stops lying,
 *  - a cache miss must not cost a full hash fetch (WP-7 trim a).
 */
export class CommandManager {
    private readonly channelId: string;
    private readonly repository: CommandRepository;
    private readonly cache: CacheManager;
    private readonly logger: Logger;
    private readonly handlers: HandlerRegistry;

    /** Authoritative in-memory copy; the cache is an optimisation over this. */
    private commands = new Map<string, CommandLookup>();
    private loaded = false;

    constructor(options: CommandManagerOptions) {
        this.channelId = options.channelId;
        this.repository = options.repository;
        this.cache = options.cache;
        this.logger = options.logger;
        this.handlers = options.handlers ?? {};
    }

    async load(): Promise<void> {
        const rows = await this.repository.listAll();
        const next = new Map<string, CommandLookup>();

        for (const row of rows) {
            const registration = row.handlerName ? this.handlers[row.handlerName] : undefined;
            const declared = registration?.level;

            // The declaration wins. Phase 0 found handler commands whose stored
            // level said 'everyone' while the real check lived inside the handler.
            if (declared && declared !== row.userLevel) {
                this.logger.warn(
                    { channelId: this.channelId, command: row.name, was: row.userLevel, now: declared },
                    'Correcting stale user_level for handler command'
                );
                await this.repository.updateUserLevel(row.name, declared);
            }

            /*
             * The same rule, applied to the sentence the app shows.
             *
             * Written here rather than served from the registry at request
             * time because the API has no registry to consult — the handlers
             * are built per session, and a channel whose bot is switched off
             * has none. Reconciling onto the row means the description is a
             * fact about the command wherever it is read from, and a built-in
             * whose wording changes is corrected on the next start.
             */
            const description = registration?.description;
            if (description !== undefined && description !== row.description) {
                await this.repository.updateDescription(row.name, description);
            }

            const level = declared ?? (isUserLevel(row.userLevel) ? row.userLevel : 'everyone');
            next.set(row.name.toLowerCase(), {
                ...row,
                userLevel: level,
                description: description ?? row.description
            });
        }

        this.commands = next;
        this.loaded = true;

        await this.cache.replaceHash(
            CacheKeys.commands(this.channelId),
            Object.fromEntries(next),
            CACHE_TTL_SECONDS
        );
    }

    /** @returns the command, or null when this channel has no such command. */
    async get(name: string): Promise<CommandLookup | null> {
        const normalized = name.toLowerCase();

        const cached = await this.cache.getHashField<CommandLookup>(
            CacheKeys.commands(this.channelId),
            normalized
        );
        if (cached.hit) return cached.value;

        // The hash exists and this field is genuinely absent - an authoritative
        // miss, so no database round-trip. This is the trim that stops every
        // ordinary chat message paying for a lookup.
        if (cached.populated) return null;

        if (!this.loaded) await this.load();
        return this.commands.get(normalized) ?? null;
    }

    /** The level a command actually requires: declaration first, row second. */
    resolveLevel(command: CommandLookup): UserLevel {
        if (command.handlerName) {
            const declared = this.handlers[command.handlerName]?.level;
            if (declared) return declared;
        }
        return command.userLevel;
    }

    canRun(command: CommandLookup, roles: ChatterRoles): boolean {
        return hasPermission(this.resolveLevel(command), roles);
    }

    async create(record: CommandRecord): Promise<void> {
        await this.repository.create(record);
        await this.load();
    }

    async updateResponse(name: string, responseText: string): Promise<boolean> {
        const updated = await this.repository.updateResponse(name, responseText);
        if (updated) await this.load();
        return updated;
    }

    async delete(name: string): Promise<boolean> {
        const deleted = await this.repository.delete(name);
        if (deleted) await this.load();
        return deleted;
    }

    getHandler(name: string): HandlerRegistry[string] | undefined {
        return this.handlers[name];
    }
}
