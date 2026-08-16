import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { randomBytes } from 'node:crypto';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { OnboardingService } from './onboarding.js';
import { createTokenCipher } from '../crypto/tokenCipher.js';
import { ChannelTokenRepository } from '../db/repositories/channelTokenRepository.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { BotIdentityRepository } from '../db/repositories/botIdentityRepository.js';
import { SessionManager } from '../session/sessionManager.js';
import { FakeTransport } from '../transport/fakeTransport.js';
import { RecordingChatSink } from '../services/chatSink.js';
import { StubAiService } from '../services/aiService.js';
import { NoopAnalyticsSink } from '../services/analytics.js';
import { CHANNEL_SCOPES, BOT_SCOPES, type TokenGrant, type ValidatedIdentity } from '../twitch/oauth.js';
import type { ChannelDependencies, ChannelRepositories } from '../bootstrap.js';
import type { CacheManager } from '../cache/cacheManager.js';

/**
 * What consent actually produces: a tenant row, encrypted credentials, a running
 * session, and a reconcile. Against a real Postgres, because "half-onboarded" is
 * the failure mode that matters and it is a persistence property.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const KEY = randomBytes(32).toString('base64');

const nullCache = (): CacheManager =>
    ({
        getHashField: async () => ({ hit: false, populated: false }),
        replaceHash: async () => true,
        getJson: async () => null,
        setJson: async () => true,
        del: async () => true
    }) as unknown as CacheManager;

const emptyRepositories = (): ChannelRepositories =>
    ({
        commands: { listAll: async () => [], updateUserLevel: vi.fn() },
        emotes: { listAll: async () => [] },
        settings: { get: async () => null },
        roles: { upsertRoles: vi.fn(), get: async () => null }
    }) as unknown as ChannelRepositories;

const identity = (overrides: Partial<ValidatedIdentity> = {}): ValidatedIdentity => ({
    userId: '1001',
    login: 'aimosthadme',
    scopes: [...CHANNEL_SCOPES],
    expiresInSeconds: 14_400,
    ...overrides
});

const grant = (overrides: Partial<TokenGrant> = {}): TokenGrant => ({
    accessToken: 'granted-access-token',
    refreshToken: 'granted-refresh-token',
    expiresInSeconds: 14_400,
    scopes: [...CHANNEL_SCOPES],
    ...overrides
});

describeDb('OnboardingService', () => {
    let handle: DbHandle;
    let manager: SessionManager;
    let reconcile: ReturnType<typeof vi.fn<() => Promise<void>>>;
    let service: OnboardingService;
    let sink: RecordingChatSink;
    const cipher = createTokenCipher(KEY);

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
    }, 60_000);

    afterAll(async () => {
        await manager?.stopAll();
        await handle?.close();
    });

    beforeEach(async () => {
        await manager?.stopAll();
        sink = new RecordingChatSink();
        manager = new SessionManager({ transport: new FakeTransport(), logger });
        await manager.start();
        reconcile = vi.fn<() => Promise<void>>(async () => undefined);

        const dependencies = (): ChannelDependencies => ({
            repositories: () => emptyRepositories(),
            cache: nullCache(),
            logger,
            chatSink: sink,
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: 'bot-1', login: 'almosthadai', aiTriggers: ['almosthadai'] }
        });

        service = new OnboardingService({
            db: handle.db, cipher, logger, sessionManager: manager, dependencies, reconcile
        });
    });

    /** Unique per test, so tests cannot collide on the broadcaster-id unique index. */
    const uniqueIdentity = (suffix: string): ValidatedIdentity =>
        identity({ userId: `onboard-${suffix}-${Date.now()}`, login: `login${suffix}` });

    describe('a channel connecting', () => {
        it('creates the tenant, stores tokens, starts the session and reconciles', async () => {
            const who = uniqueIdentity('a');

            const result = await service.onboardChannel(who, grant());

            expect(result.channel.twitchBroadcasterId).toBe(who.userId);
            expect(result.sessionStarted).toBe(true);
            expect(result.missingScopes).toEqual([]);
            expect(manager.get(result.channel.id)).toBeDefined();
            expect(reconcile).toHaveBeenCalledTimes(1);
        });

        it('stores the credentials encrypted', async () => {
            const who = uniqueIdentity('b');
            const result = await service.onboardChannel(who, grant());

            const [row] = await handle.sql<{ access_token: string }[]>`
                select access_token from channel_tokens where channel_id = ${result.channel.id}
            `;
            expect(row?.access_token).not.toContain('granted-access-token');

            const stored = await new ChannelTokenRepository(handle.db, result.channel.id, cipher).get('twitch');
            expect(stored).toMatchObject({
                accessToken: 'granted-access-token', refreshToken: 'granted-refresh-token'
            });
        });

        it('records an expiry so the refresh path knows when to act', async () => {
            const result = await service.onboardChannel(uniqueIdentity('c'), grant());
            const stored = await new ChannelTokenRepository(handle.db, result.channel.id, cipher).get('twitch');

            expect(stored?.expiresAt).toBeInstanceOf(Date);
            expect((stored?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('is idempotent - reconnecting updates rather than duplicating', async () => {
            const who = uniqueIdentity('d');

            const first = await service.onboardChannel(who, grant());
            const second = await service.onboardChannel(who, grant({ accessToken: 'rotated' }));

            expect(second.channel.id).toBe(first.channel.id);
            const stored = await new ChannelTokenRepository(handle.db, first.channel.id, cipher).get('twitch');
            expect(stored?.accessToken).toBe('rotated');
        });

        it('reports scopes the user declined without failing', async () => {
            // A channel that declined moderator:read:chatters still works, minus
            // the presence poll. Naming it is what makes the gap diagnosable.
            const result = await service.onboardChannel(
                uniqueIdentity('e'),
                grant({ scopes: ['channel:bot', 'channel:read:redemptions'] })
            );

            expect(result.missingScopes).toContain('moderator:read:chatters');
            expect(result.missingScopes).toContain('channel:manage:redemptions');
            expect(result.sessionStarted).toBe(true);
        });

        it('trusts the validated identity, not anything the caller supplied', async () => {
            // The login comes from Twitch's validate endpoint; trusting any other
            // source would let a user onboard a channel they do not own.
            const who = uniqueIdentity('f');
            const result = await service.onboardChannel(who, grant());

            expect(result.channel.twitchLogin).toBe(who.login);
        });

        it('reconnecting clears needs_reauth', async () => {
            const who = uniqueIdentity('g');
            const first = await service.onboardChannel(who, grant());
            await new ChannelRepository(handle.db).setStatus(first.channel.id, 'needs_reauth');

            const again = await service.onboardChannel(who, grant());

            expect(again.channel.status).toBe('active');
        });
    });

    describe('robustness', () => {
        it('still persists the channel when its session fails to start', async () => {
            // A row with tokens and no session recovers on the next boot; the
            // reverse would lose the credentials entirely.
            const failing = new OnboardingService({
                db: handle.db, cipher, logger, sessionManager: manager, reconcile,
                dependencies: () => ({
                    repositories: () => ({
                        commands: { listAll: async () => { throw new Error('boom'); } }
                    } as unknown as ChannelRepositories),
                    cache: nullCache(), logger, chatSink: sink,
                    ai: new StubAiService(), analytics: new NoopAnalyticsSink(),
                    bot: { twitchUserId: 'bot-1', login: 'b', aiTriggers: ['b'] }
                })
            });

            const who = uniqueIdentity('h');
            const result = await failing.onboardChannel(who, grant());

            expect(result.sessionStarted).toBe(false);
            expect(await new ChannelRepository(handle.db).findByBroadcasterId(who.userId)).not.toBeNull();
        });

        it('completes even when the reconcile fails', async () => {
            // Reconciliation converges; a failure now is retried next time and
            // must not undo a successful onboarding.
            reconcile.mockRejectedValue(new Error('helix down'));

            const result = await service.onboardChannel(uniqueIdentity('i'), grant());

            expect(result.sessionStarted).toBe(true);
        });

        it('does not restart a session that is already running', async () => {
            const who = uniqueIdentity('j');
            const first = await service.onboardChannel(who, grant());
            const session = manager.get(first.channel.id);

            await service.onboardChannel(who, grant());

            expect(manager.get(first.channel.id)).toBe(session);
        });
    });

    describe('bot consent', () => {
        it('records the identity with the refresh token encrypted', async () => {
            const who = identity({ userId: 'bot-777', login: 'almosthadai', scopes: [...BOT_SCOPES] });

            const result = await service.recordBotConsent(who, grant({ scopes: [...BOT_SCOPES] }));

            expect(result.missingScopes).toEqual([]);

            const [row] = await handle.sql<{ refresh_token: string }[]>`select refresh_token from bot_identity`;
            expect(row?.refresh_token).not.toContain('granted-refresh-token');
            expect(await new BotIdentityRepository(handle.db, cipher).getRefreshToken())
                .toBe('granted-refresh-token');
        });

        it('reports missing bot scopes, which break chat everywhere', async () => {
            const who = identity({ userId: 'bot-778', login: 'almosthadai', scopes: ['user:bot'] });

            const result = await service.recordBotConsent(who, grant({ scopes: ['user:bot'] }));

            expect(result.missingScopes).toContain('user:read:chat');
            expect(result.missingScopes).toContain('user:write:chat');
        });

        it('notifies the running process so consent takes effect without a restart', async () => {
            // Bot identity is read once at boot. Without this hook a fresh
            // consent sits in the database while the process keeps answering as
            // the previous account - which is exactly what happened during
            // P1-WP6 activation.
            const applied: string[] = [];
            const notifying = new OnboardingService({
                db: handle.db, cipher, logger, sessionManager: manager, reconcile,
                dependencies: () => ({
                    repositories: () => emptyRepositories(),
                    cache: nullCache(), logger, chatSink: sink,
                    ai: new StubAiService(), analytics: new NoopAnalyticsSink(),
                    bot: { twitchUserId: 'bot-1', login: 'b', aiTriggers: ['b'] }
                }),
                onBotIdentityChanged: async () => { applied.push('applied'); }
            });

            await notifying.recordBotConsent(
                identity({ userId: 'bot-hook', login: 'almosthadai', scopes: [...BOT_SCOPES] }),
                grant({ scopes: [...BOT_SCOPES] })
            );

            expect(applied).toEqual(['applied']);
        });

        it('keeps the consent when applying it to the running process fails', async () => {
            // The grant is already durable; a failure here degrades to "restart
            // to pick it up" rather than losing the authorization.
            const failing = new OnboardingService({
                db: handle.db, cipher, logger, sessionManager: manager, reconcile,
                dependencies: () => ({
                    repositories: () => emptyRepositories(),
                    cache: nullCache(), logger, chatSink: sink,
                    ai: new StubAiService(), analytics: new NoopAnalyticsSink(),
                    bot: { twitchUserId: 'bot-1', login: 'b', aiTriggers: ['b'] }
                }),
                onBotIdentityChanged: async () => { throw new Error('rebuild exploded'); }
            });

            await expect(failing.recordBotConsent(
                identity({ userId: 'bot-durable', login: 'almosthadai', scopes: [...BOT_SCOPES] }),
                grant({ scopes: [...BOT_SCOPES] })
            )).resolves.toMatchObject({ missingScopes: [] });

            expect(await new BotIdentityRepository(handle.db, cipher).get())
                .toMatchObject({ twitchUserId: 'bot-durable' });
        });

        it('replaces a previous bot account rather than accumulating rows', async () => {
            await service.recordBotConsent(
                identity({ userId: 'bot-old', login: 'old', scopes: [...BOT_SCOPES] }),
                grant({ scopes: [...BOT_SCOPES] })
            );
            await service.recordBotConsent(
                identity({ userId: 'bot-new', login: 'new', scopes: [...BOT_SCOPES] }),
                grant({ scopes: [...BOT_SCOPES] })
            );

            const rows = await handle.sql<{ twitch_user_id: string }[]>`select twitch_user_id from bot_identity`;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.twitch_user_id).toBe('bot-new');
        });
    });
});

describeDb('runtime onboarding binds rewards', () => {
    /**
     * The third instance of the boot-only-capability class, found by sweeping
     * after the playback monitor: reward adoption ran only at boot, so a channel
     * that connected at runtime had no bound rewards — and every redemption in
     * it was treated as unmanaged and silently ignored until the next restart.
     *
     * That is the friend's onboarding path, so it would have failed on their
     * first redemption.
     */
    let handle: DbHandle;
    let manager: SessionManager;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
    }, 60_000);

    afterAll(async () => {
        await manager?.stopAll();
        await handle?.close();
    });

    const buildService = (adopted: string[]): OnboardingService => new OnboardingService({
        db: handle.db,
        cipher: createTokenCipher(randomBytes(32).toString('base64')),
        logger,
        sessionManager: manager,
        dependencies: () => ({
            repositories: () => ({
                commands: { listAll: async () => [], updateUserLevel: vi.fn() },
                emotes: { listAll: async () => [] },
                settings: { get: async () => null },
                roles: { upsertRoles: vi.fn(), get: async () => null },
                quotes: {}
            } as unknown as ChannelRepositories),
            cache: nullCache(),
            logger,
            chatSink: new RecordingChatSink(),
            ai: new StubAiService(),
            analytics: new NoopAnalyticsSink(),
            bot: { twitchUserId: 'bot-1', login: 'b', aiTriggers: ['b'] }
        }),
        reconcile: async () => undefined,
        adoptRewards: async (channelId) => { adopted.push(channelId); }
    });

    it('adopts rewards for a channel that connects at runtime', async () => {
        manager = new SessionManager({ transport: new FakeTransport(), logger });
        await manager.start();

        const adopted: string[] = [];
        const result = await buildService(adopted).onboardChannel(
            identity({ userId: `rt-${Date.now()}`, login: 'runtimechannel' }),
            grant()
        );

        expect(adopted).toEqual([result.channel.id]);
    });

    it('still completes onboarding when adoption fails', async () => {
        // A channel with tokens and no bound rewards recovers on the next boot;
        // losing the connection entirely would not.
        manager = new SessionManager({ transport: new FakeTransport(), logger });
        await manager.start();

        const failing = new OnboardingService({
            db: handle.db,
            cipher: createTokenCipher(randomBytes(32).toString('base64')),
            logger,
            sessionManager: manager,
            dependencies: () => ({
                repositories: () => ({
                    commands: { listAll: async () => [], updateUserLevel: vi.fn() },
                    emotes: { listAll: async () => [] },
                    settings: { get: async () => null },
                    roles: { upsertRoles: vi.fn(), get: async () => null },
                    quotes: {}
                } as unknown as ChannelRepositories),
                cache: nullCache(),
                logger,
                chatSink: new RecordingChatSink(),
                ai: new StubAiService(),
                analytics: new NoopAnalyticsSink(),
                bot: { twitchUserId: 'bot-1', login: 'b', aiTriggers: ['b'] }
            }),
            reconcile: async () => undefined,
            adoptRewards: async () => { throw new Error('helix down'); }
        });

        await expect(failing.onboardChannel(
            identity({ userId: `rt-fail-${Date.now()}`, login: 'failchannel' }),
            grant()
        )).resolves.toMatchObject({ sessionStarted: true });
    });
});
