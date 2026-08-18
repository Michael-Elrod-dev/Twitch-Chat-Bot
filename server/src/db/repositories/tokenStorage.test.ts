import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import type { DbHandle } from '../client.js';
import { connectTestDatabase } from '../testing.js';
import { ChannelTokenRepository } from './channelTokenRepository.js';
import { BotIdentityRepository } from './botIdentityRepository.js';
import { AppSessionRepository } from './appSessionRepository.js';
import { ChannelRepository } from './channelRepository.js';
import { createTokenCipher } from '../../crypto/tokenCipher.js';
import { TokenCryptoError } from '../../crypto/tokenCrypto.js';
import { generateRefreshToken } from '../../auth/jwt.js';

/**
 * Encryption verified against a real Postgres, because the property that matters
 * is what is actually on disk. A unit test against a mock could pass while the
 * column held plaintext.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const KEY = randomBytes(32).toString('base64');
const ACCESS = 'access-token-that-must-never-be-readable';
const REFRESH = 'refresh-token-that-must-never-be-readable';

describeDb('encrypted token storage', () => {
    let handle: DbHandle;
    let sql: postgres.Sql;
    let channelId: string;
    const cipher = createTokenCipher(KEY);

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        sql = handle.sql;

        const channel = await new ChannelRepository(handle.db).upsert({
            twitchBroadcasterId: `tok-${Date.now()}`,
            twitchLogin: 'tokenchannel',
            displayName: 'Token Channel'
        });
        channelId = channel.id;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    describe('ChannelTokenRepository', () => {
        it('round-trips a token pair', async () => {
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', {
                accessToken: ACCESS, refreshToken: REFRESH,
                expiresAt: new Date(Date.now() + 3600_000), scopes: ['channel:bot']
            });

            expect(await repo.get('twitch')).toMatchObject({
                accessToken: ACCESS, refreshToken: REFRESH, scopes: ['channel:bot']
            });
        });

        it('stores ciphertext on disk, not the token', async () => {
            // The whole point: a leaked dump yields nothing usable.
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', {
                accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, scopes: []
            });

            const [row] = await sql<{ access_token: string; refresh_token: string }[]>`
                select access_token, refresh_token from channel_tokens where channel_id = ${channelId}
            `;

            expect(row?.access_token).not.toContain(ACCESS);
            expect(row?.refresh_token).not.toContain(REFRESH);
            expect(row?.access_token.startsWith('v1.')).toBe(true);
        });

        it('cannot be read with a different key', async () => {
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', {
                accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, scopes: []
            });

            const wrongKey = new ChannelTokenRepository(
                handle.db, channelId, createTokenCipher(randomBytes(32).toString('base64'))
            );

            await expect(wrongKey.get('twitch')).rejects.toThrow(TokenCryptoError);
        });

        it('rotates both halves together', async () => {
            // Twitch issues a new refresh token on every refresh; a partial write
            // could strand the channel holding a retired one.
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', { accessToken: 'a1', refreshToken: 'r1', expiresAt: null, scopes: [] });
            await repo.upsert('twitch', { accessToken: 'a2', refreshToken: 'r2', expiresAt: null, scopes: [] });

            expect(await repo.get('twitch')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
        });

        it('keeps providers separate', async () => {
            const repo = new ChannelTokenRepository(handle.db, channelId, cipher);
            await repo.upsert('twitch', { accessToken: 'tw', refreshToken: 'twr', expiresAt: null, scopes: [] });
            await repo.upsert('spotify', { accessToken: 'sp', refreshToken: 'spr', expiresAt: null, scopes: [] });

            expect((await repo.get('twitch'))?.accessToken).toBe('tw');
            expect((await repo.get('spotify'))?.accessToken).toBe('sp');
        });

        it('cannot see another channel tokens', async () => {
            const other = await new ChannelRepository(handle.db).upsert({
                twitchBroadcasterId: `tok-other-${Date.now()}`, twitchLogin: 'other', displayName: null
            });

            await new ChannelTokenRepository(handle.db, channelId, cipher)
                .upsert('twitch', { accessToken: 'mine', refreshToken: 'mine-r', expiresAt: null, scopes: [] });

            expect(await new ChannelTokenRepository(handle.db, other.id, cipher).get('twitch')).toBeNull();
        });

        it('returns null when nothing is stored', async () => {
            const fresh = await new ChannelRepository(handle.db).upsert({
                twitchBroadcasterId: `tok-empty-${Date.now()}`, twitchLogin: 'empty', displayName: null
            });

            expect(await new ChannelTokenRepository(handle.db, fresh.id, cipher).get('twitch')).toBeNull();
        });

        it('reads an ETL-imported plaintext row only when explicitly tolerated', async () => {
            const imported = await new ChannelRepository(handle.db).upsert({
                twitchBroadcasterId: `tok-imported-${Date.now()}`, twitchLogin: 'imported', displayName: null
            });
            await sql`
                insert into channel_tokens (channel_id, provider, access_token, refresh_token)
                values (${imported.id}, 'twitch', 'plain-access', 'plain-refresh')
            `;

            const repo = new ChannelTokenRepository(handle.db, imported.id, cipher);

            await expect(repo.get('twitch')).rejects.toThrow(TokenCryptoError);
            expect(await repo.get('twitch', true)).toMatchObject({ accessToken: 'plain-access' });
        });
    });

    describe('BotIdentityRepository', () => {
        it('encrypts the stored refresh token', async () => {
            const repo = new BotIdentityRepository(handle.db, cipher);
            await repo.replaceWith({
                twitchUserId: 'bot-1', twitchLogin: 'almosthadai',
                grantedScopes: ['user:bot'], refreshToken: REFRESH
            });

            const [row] = await sql<{ refresh_token: string }[]>`select refresh_token from bot_identity`;

            expect(row?.refresh_token).not.toContain(REFRESH);
            expect(await repo.getRefreshToken()).toBe(REFRESH);
        });

        it('keeps exactly one identity when the bot account changes', async () => {
            // Two rows would give resolveBotIdentity an arbitrary winner.
            const repo = new BotIdentityRepository(handle.db, cipher);
            await repo.replaceWith({
                twitchUserId: 'bot-1', twitchLogin: 'old', grantedScopes: [], refreshToken: null
            });
            await repo.replaceWith({
                twitchUserId: 'bot-2', twitchLogin: 'new', grantedScopes: [], refreshToken: null
            });

            const rows = await sql<{ twitch_user_id: string }[]>`select twitch_user_id from bot_identity`;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.twitch_user_id).toBe('bot-2');
        });

        it('accepts consent with no refresh token', async () => {
            const repo = new BotIdentityRepository(handle.db, cipher);
            await repo.replaceWith({
                twitchUserId: 'bot-3', twitchLogin: 'x', grantedScopes: ['user:bot'], refreshToken: null
            });

            expect(await repo.getRefreshToken()).toBeNull();
            expect(await repo.get()).toMatchObject({ twitchUserId: 'bot-3' });
        });
    });

    describe('AppSessionRepository', () => {
        it('resolves a session by its refresh token', async () => {
            const repo = new AppSessionRepository(handle.db);
            const { token } = generateRefreshToken();
            await repo.create(token, { twitchUserId: '1001', login: 'someone' });

            expect(await repo.resolve(token)).toMatchObject({ twitchUserId: '1001', login: 'someone' });
        });

        it('stores only the hash', async () => {
            const repo = new AppSessionRepository(handle.db);
            const { token } = generateRefreshToken();
            await repo.create(token, { twitchUserId: '1002', login: 'x' });

            const rows = await sql<{ token_hash: string }[]>`
                select token_hash from app_refresh_tokens where twitch_user_id = '1002'
            `;
            expect(rows[0]?.token_hash).not.toBe(token);
        });

        it('refuses an unknown token', async () => {
            expect(await new AppSessionRepository(handle.db).resolve('invented')).toBeNull();
        });

        it('refuses an expired token', async () => {
            const repo = new AppSessionRepository(handle.db);
            const { token } = generateRefreshToken();
            await repo.create(token, { twitchUserId: '1003', login: 'x' }, new Date(Date.now() - 400 * 24 * 3600_000));

            expect(await repo.resolve(token)).toBeNull();
        });

        it('revokes a single session', async () => {
            const repo = new AppSessionRepository(handle.db);
            const { token } = generateRefreshToken();
            await repo.create(token, { twitchUserId: '1004', login: 'x' });

            expect(await repo.revoke(token)).toBe(true);
            expect(await repo.resolve(token)).toBeNull();
        });

        it('revokes every session for one user', async () => {
            const repo = new AppSessionRepository(handle.db);
            const first = generateRefreshToken();
            const second = generateRefreshToken();
            await repo.create(first.token, { twitchUserId: '1005', login: 'x' });
            await repo.create(second.token, { twitchUserId: '1005', login: 'x' });

            expect(await repo.revokeAllFor('1005')).toBe(2);
            expect(await repo.resolve(first.token)).toBeNull();
        });
    });

    describe('channel status', () => {
        it('accepts needs_reauth, which migration 0001 added', async () => {
            const channels = new ChannelRepository(handle.db);
            expect(await channels.setStatus(channelId, 'needs_reauth')).toBe(true);

            const [row] = await sql<{ status: string }[]>`select status from channels where id = ${channelId}`;
            expect(row?.status).toBe('needs_reauth');
        });

        it('still rejects a status outside the CHECK constraint', async () => {
            // Drizzle's enum is TypeScript-only; the constraint is what actually
            // stops the ETL or a manual fix writing junk.
            await expect(
                sql`update channels set status = 'wizard' where id = ${channelId}`
            ).rejects.toThrow(/channels_status_check/);
        });

        it('reconnecting returns a needs_reauth channel to active', async () => {
            const channels = new ChannelRepository(handle.db);
            const [existing] = await sql<{ twitch_broadcaster_id: string; twitch_login: string }[]>`
                select twitch_broadcaster_id, twitch_login from channels where id = ${channelId}
            `;
            await channels.setStatus(channelId, 'needs_reauth');

            const reconnected = await channels.upsert({
                twitchBroadcasterId: existing?.twitch_broadcaster_id as string,
                twitchLogin: existing?.twitch_login as string,
                displayName: null
            });

            expect(reconnected.id).toBe(channelId);
            expect(reconnected.status).toBe('active');
        });
    });
});
