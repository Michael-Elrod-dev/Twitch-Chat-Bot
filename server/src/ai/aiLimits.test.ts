import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pino } from 'pino';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelSettingsRepository } from '../db/repositories/channelSettingsRepository.js';
import { SettingsService } from '../domain/settings.js';
import { MapCache, asCacheManager } from '../cache/testing.js';
import { AiRateLimiter, DEFAULT_STREAM_LIMITS, streamLimitsFrom, limitFor } from './rateLimiter.js';

/**
 * Per-role AI budgets: stored, editable, and read at the moment of the decision.
 *
 * The limits used to be a constant captured by the limiter at construction,
 * which is the same class of defect as the content hole: a value the running
 * bot froze at start, with no path from an edit to the thing enforcing it. The
 * tests that matter here are therefore not "does the number save" but "does the
 * saved number decide the next request".
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });

const viewer = { isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false };

describe('limit selection', () => {
    it('gives someone holding several tiers the best of them', () => {
        const limits = { broadcaster: 999, mod: 10, subscriber: 15, vip: 3, everyone: 1 };

        // A subscriber who is also a VIP gets 15, not the 3 a lookup ordered by
        // "most prestigious role" would hand them.
        expect(limitFor({ ...viewer, isSubscriber: true, isVip: true }, limits)).toBe(15);
    });

    it('fills the broadcaster tier from the constant, since it is never stored', () => {
        const built = streamLimitsFrom({ everyone: 1, vip: 2, subscriber: 3, moderator: 4 });

        expect(built).toEqual({
            broadcaster: DEFAULT_STREAM_LIMITS.broadcaster,
            mod: 4, subscriber: 3, vip: 2, everyone: 1
        });
    });
});

describeDb('AI limits reach the running bot', () => {
    let handle: DbHandle;
    let channelId: string;
    let cache: MapCache;
    let settings: SettingsService;
    let limiter: AiRateLimiter;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);

        const channels = new ChannelRepository(handle.db);
        const row = await channels.upsert({
            twitchBroadcasterId: `ailimits-${Date.now()}`, twitchLogin: 'ailimits', displayName: null
        });
        channelId = row.id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    beforeEach(async () => {
        await handle.sql`delete from api_usage where channel_id = ${channelId}`;
        await handle.sql`delete from channel_settings where channel_id = ${channelId}`;

        // A real cache, as in production. With a null one the limiter would
        // re-read the database every check and the invalidation this proves
        // would never be exercised.
        cache = new MapCache();
        settings = new SettingsService({
            channelId,
            repository: new ChannelSettingsRepository(handle.db, channelId),
            cache: asCacheManager(cache),
            logger
        });

        limiter = new AiRateLimiter({
            db: handle.db,
            channelId,
            limits: async () => streamLimitsFrom((await settings.get()).aiLimits)
        });
    });

    it('starts every channel on the constant the limiter used to hold', async () => {
        const decision = await limiter.check('viewer-1', viewer, null);

        // The migration's column defaults, read back through the whole stack.
        // If the SQL literals and `DEFAULT_STREAM_LIMITS` ever drift, this is
        // where it shows. The two are restated in different languages and
        // nothing but a test can hold them together.
        expect(decision.limit).toBe(DEFAULT_STREAM_LIMITS.everyone);
    });

    it('enforces a lowered limit on the very next request', async () => {
        // Warm the cache the way a live channel does, so the change has
        // something stale to beat.
        expect((await limiter.check('viewer-1', viewer, null)).limit).toBe(5);

        await settings.update({ aiLimits: { everyone: 1, vip: 1, subscriber: 1, moderator: 1 } });

        // One request spent, and the budget is now one.
        await limiter.record('viewer-1', null);

        const decision = await limiter.check('viewer-1', viewer, null);
        // The owner's live proof, as a test: set Everyone to 1, and the second
        // request is refused without a restart.
        expect(decision).toEqual({ allowed: false, used: 1, limit: 1 });
    });

    it('restores the budget when the limit goes back up', async () => {
        await settings.update({ aiLimits: { everyone: 1, vip: 1, subscriber: 1, moderator: 1 } });
        await limiter.record('viewer-1', null);
        expect((await limiter.check('viewer-1', viewer, null)).allowed).toBe(false);

        await settings.update({ aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 } });

        // The other direction matters too: a stale low limit would leave the
        // bot refusing viewers the owner has just re-admitted.
        expect((await limiter.check('viewer-1', viewer, null)).allowed).toBe(true);
    });

    it('gives a moderator their own tier, not everyone else', async () => {
        await settings.update({ aiLimits: { everyone: 0, vip: 0, subscriber: 0, moderator: 7 } });

        const asMod = await limiter.check('mod-1', { ...viewer, isModerator: true }, null);
        const asViewer = await limiter.check('viewer-1', viewer, null);

        expect(asMod.limit).toBe(7);
        // Zero is a real setting: the AI is off for ordinary viewers and on for
        // mods, which is a configuration the screen has to be able to express.
        expect(asViewer).toEqual({ allowed: false, used: 0, limit: 0 });
    });

    it('leaves the broadcaster unlimited whatever the stored tiers say', async () => {
        await settings.update({ aiLimits: { everyone: 0, vip: 0, subscriber: 0, moderator: 0 } });

        const decision = await limiter.check('owner', { ...viewer, isBroadcaster: true }, null);
        expect(decision.allowed).toBe(true);
        expect(decision.limit).toBe(DEFAULT_STREAM_LIMITS.broadcaster);
    });
});
