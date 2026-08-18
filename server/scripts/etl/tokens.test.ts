import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { DbHandle } from '../../src/db/client.js';
import { connectTestDatabase } from '../../src/db/testing.js';
import { importChannelTokens, importBotIdentity } from './tokens.js';
import { ChannelRepository } from '../../src/db/repositories/channelRepository.js';
import { ChannelTokenRepository } from '../../src/db/repositories/channelTokenRepository.js';
import { BotIdentityRepository } from '../../src/db/repositories/botIdentityRepository.js';
import { createTokenCipher } from '../../src/crypto/tokenCipher.js';

/**
 * The rule this file exists to defend: **a live authorization always beats a
 * value from the dump.**
 *
 * The ETL originally deleted `channel_tokens` and re-inserted from the dump,
 * which would have replaced a working encrypted credential with a dead plaintext
 * one, silently disconnecting the channel it was supposed to be restoring.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const KEY = randomBytes(32).toString('base64');
const LIVE_ACCESS = 'live-access-token-granted-today';
const LIVE_REFRESH = 'live-refresh-token-granted-today';
const DUMP_ACCESS = 'stale-access-token-from-january';
const DUMP_REFRESH = 'stale-refresh-token-from-january';

const dumpSource = () => ({ accessToken: DUMP_ACCESS, refreshToken: DUMP_REFRESH });

describeDb('ETL credential handling', () => {
    let handle: DbHandle;
    const cipher = createTokenCipher(KEY);

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    const freshChannel = async (suffix: string): Promise<string> => {
        const channel = await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: `etl-${suffix}-${Date.now()}-${Math.floor(process.hrtime()[1])}`,
            twitchLogin: `etl${suffix}`,
            displayName: null
        });
        return channel.id;
    };

    describe('channel_tokens', () => {
        it('preserves a live credential and does NOT import the dump value', async () => {
            const channelId = await freshChannel('preserve');
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', {
                accessToken: LIVE_ACCESS, refreshToken: LIVE_REFRESH,
                expiresAt: new Date(Date.now() + 3600_000), scopes: ['channel:bot']
            });

            const outcomes = await importChannelTokens(handle.sql, channelId, dumpSource);

            expect(outcomes.find((o) => o.provider === 'twitch')?.action).toBe('preserved');
            // Still today's, still decryptable, still carrying today's scopes.
            expect(await repo.get('twitch')).toMatchObject({
                accessToken: LIVE_ACCESS, refreshToken: LIVE_REFRESH, scopes: ['channel:bot']
            });
        });

        it('leaves exactly one row - it does not add a second alongside', async () => {
            const channelId = await freshChannel('single');
            await new ChannelTokenRepository(handle.db, channelId, cipher).upsert('twitch', {
                accessToken: LIVE_ACCESS, refreshToken: LIVE_REFRESH, expiresAt: null, scopes: []
            });

            await importChannelTokens(handle.sql, channelId, dumpSource);

            const rows = await handle.sql<{ n: number }[]>`
                select count(*)::int as n from channel_tokens
                where channel_id = ${channelId} and provider = 'twitch'
            `;
            expect(rows[0]?.n).toBe(1);
        });

        it('imports when the channel genuinely has no credentials', async () => {
            // The restore case the ETL exists for.
            const channelId = await freshChannel('import');

            const outcomes = await importChannelTokens(handle.sql, channelId, dumpSource);

            expect(outcomes.find((o) => o.provider === 'twitch')?.action).toBe('imported');
            const [row] = await handle.sql<{ access_token: string }[]>`
                select access_token from channel_tokens where channel_id = ${channelId} and provider = 'twitch'
            `;
            expect(row?.access_token).toBe(DUMP_ACCESS);
        });

        it('preserves per provider independently', async () => {
            // A channel with live Twitch tokens but no Spotify connection should
            // keep one and receive the other.
            const channelId = await freshChannel('mixed');
            await new ChannelTokenRepository(handle.db, channelId, cipher).upsert('twitch', {
                accessToken: LIVE_ACCESS, refreshToken: LIVE_REFRESH, expiresAt: null, scopes: []
            });

            const outcomes = await importChannelTokens(handle.sql, channelId, dumpSource);

            expect(outcomes).toEqual([
                { provider: 'twitch', action: 'preserved' },
                { provider: 'spotify', action: 'imported' }
            ]);
        });

        it('reports absent when the dump has nothing for a provider', async () => {
            const channelId = await freshChannel('absent');

            const outcomes = await importChannelTokens(handle.sql, channelId, () => ({
                accessToken: undefined, refreshToken: undefined
            }));

            expect(outcomes.every((o) => o.action === 'absent')).toBe(true);
        });

        it('is idempotent - a second run preserves what the first imported', async () => {
            const channelId = await freshChannel('twice');

            await importChannelTokens(handle.sql, channelId, dumpSource);
            const second = await importChannelTokens(handle.sql, channelId, dumpSource);

            expect(second.every((o) => o.action === 'preserved')).toBe(true);
        });
    });

    describe('bot_identity', () => {
        it('preserves a live consent record', async () => {
            await handle.sql`delete from bot_identity`;
            const repo = new BotIdentityRepository(handle.db, cipher);
            await repo.replaceWith({
                twitchUserId: 'live-bot', twitchLogin: 'almosthadai',
                grantedScopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
                refreshToken: LIVE_REFRESH
            });

            const outcome = await importBotIdentity(handle.sql, {
                twitchUserId: 'dump-bot', login: 'almosthadai', refreshToken: DUMP_REFRESH
            });

            expect(outcome).toBe('preserved');
            expect(await repo.get()).toMatchObject({ twitchUserId: 'live-bot' });
            expect(await repo.getRefreshToken()).toBe(LIVE_REFRESH);
        });

        it('does not replace real granted scopes with the ETL guess', async () => {
            // The dump records no scopes at all, so the import's list is a
            // guess. A consent record knows what was granted.
            await handle.sql`delete from bot_identity`;
            await new BotIdentityRepository(handle.db, cipher).replaceWith({
                twitchUserId: 'live-bot', twitchLogin: 'almosthadai',
                grantedScopes: ['user:bot'], refreshToken: null
            });

            await importBotIdentity(handle.sql, {
                twitchUserId: 'dump-bot', login: 'almosthadai', refreshToken: DUMP_REFRESH
            });

            expect(await new BotIdentityRepository(handle.db, cipher).get())
                .toMatchObject({ grantedScopes: ['user:bot'] });
        });

        it('imports when no consent has ever been recorded', async () => {
            await handle.sql`delete from bot_identity`;

            const outcome = await importBotIdentity(handle.sql, {
                twitchUserId: 'dump-bot', login: 'almosthadai', refreshToken: DUMP_REFRESH
            });

            expect(outcome).toBe('imported');
            const rows = await handle.sql<{ twitch_user_id: string }[]>`select twitch_user_id from bot_identity`;
            expect(rows[0]?.twitch_user_id).toBe('dump-bot');
        });

        it('leaves exactly one identity row either way', async () => {
            await handle.sql`delete from bot_identity`;
            await importBotIdentity(handle.sql, { twitchUserId: 'b1', login: 'x', refreshToken: null });
            await importBotIdentity(handle.sql, { twitchUserId: 'b2', login: 'y', refreshToken: null });

            const rows = await handle.sql<{ n: number }[]>`select count(*)::int as n from bot_identity`;
            expect(rows[0]?.n).toBe(1);
        });
    });
});
