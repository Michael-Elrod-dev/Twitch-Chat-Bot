import type { Logger } from '../logger.js';
import type { Database } from '../db/client.js';
import type { TokenCipher } from '../crypto/tokenCipher.js';
import { ChannelRepository, type ChannelRecord } from '../db/repositories/channelRepository.js';
import { BotIdentityRepository } from '../db/repositories/botIdentityRepository.js';
import { ChannelTokenRepository } from '../db/repositories/channelTokenRepository.js';
import { CHANNEL_SCOPES, BOT_SCOPES, missingScopes, type TokenGrant, type ValidatedIdentity } from '../twitch/oauth.js';
import type { SessionManager } from '../session/sessionManager.js';
import type { ChannelDependencies } from '../bootstrap.js';
import { buildChannelSession } from '../bootstrap.js';

/**
 * What happens after consent.
 *
 * Onboarding is deliberately one transaction-shaped unit: identify, persist,
 * start, subscribe. A channel that is half-onboarded — a row with no tokens, or
 * tokens with no session — is worse than one that failed outright, because it
 * looks connected and is not.
 */

export interface OnboardingResult {
    channel: ChannelRecord;
    /** Requested but not granted. A user can untick scopes on the consent screen. */
    missingScopes: string[];
    sessionStarted: boolean;
}

export interface ChannelOnboardingOptions {
    db: Database;
    cipher: TokenCipher;
    logger: Logger;
    sessionManager: SessionManager;
    /** Rebuilt per onboarding so the new channel gets its own repositories. */
    dependencies: () => ChannelDependencies;
    /** Runs the live subscription diff once the channel is registered. */
    reconcile: () => Promise<void>;
    /** Binds the bot's reward kinds for a newly-connected channel. */
    adoptRewards?: (channelId: string, broadcasterTwitchId: string) => Promise<void>;
    /**
     * Called after the bot account's consent changes.
     *
     * Bot identity is read once at boot, so without this a fresh consent sits in
     * the database while the running process keeps using the previous value —
     * the bot would answer as the wrong account until someone restarted it. That
     * is a bad enough failure on a laptop and a worse one on a server nobody is
     * watching.
     */
    onBotIdentityChanged?: () => Promise<void>;
}

export class OnboardingService {
    private readonly options: ChannelOnboardingOptions;

    constructor(options: ChannelOnboardingOptions) {
        this.options = options;
    }

    /**
     * Connects a broadcaster's channel.
     *
     * @param identity from Twitch's validate endpoint — the authoritative answer
     * to "whose token is this". Trusting a login supplied any other way would let
     * a user onboard a channel they do not own.
     */
    async onboardChannel(identity: ValidatedIdentity, grant: TokenGrant): Promise<OnboardingResult> {
        const { db, cipher, logger, sessionManager } = this.options;

        const channels = new ChannelRepository(db);
        const channel = await channels.upsert({
            twitchBroadcasterId: identity.userId,
            twitchLogin: identity.login,
            displayName: identity.login
        });

        const tokens = new ChannelTokenRepository(db, channel.id, cipher);
        await tokens.upsert('twitch', {
            accessToken: grant.accessToken,
            refreshToken: grant.refreshToken,
            expiresAt: grant.expiresInSeconds > 0 ? new Date(Date.now() + grant.expiresInSeconds * 1000) : null,
            scopes: grant.scopes
        });

        const missing = missingScopes(CHANNEL_SCOPES, grant.scopes);
        if (missing.length > 0) {
            // Not fatal: a channel that declined `moderator:read:chatters` still
            // works, minus the presence poll. Naming them is what makes the
            // eventual "why is X not working" answerable.
            logger.warn(
                { channelId: channel.id, login: channel.twitchLogin, missing },
                'Channel connected without every requested scope - some features will be unavailable'
            );
        }

        // A restart would pick the channel up anyway, but making it live now is
        // the difference between "connected" and "connected after you restart".
        let sessionStarted = false;
        try {
            if (!sessionManager.get(channel.id)) {
                await sessionManager.add(buildChannelSession(this.options.dependencies(), channel));
            }
            sessionStarted = true;
        } catch (err) {
            logger.error(
                { channelId: channel.id, err: (err as Error).message },
                'Channel onboarded but its session failed to start - it will start on the next boot'
            );
        }

        /*
         * Bind the reward kinds BEFORE reconciling subscriptions, so a
         * redemption arriving the moment the subscription goes live already has
         * somewhere to route.
         *
         * Without this, adoption only ever ran at boot — so a channel that
         * onboarded at runtime had no bound rewards and every redemption in it
         * was treated as unmanaged and silently ignored until the next restart.
         * Same class as the playback monitor and the bot identity.
         */
        try {
            await this.options.adoptRewards?.(channel.id, channel.twitchBroadcasterId);
        } catch (err) {
            logger.error(
                { channelId: channel.id, err: (err as Error).message },
                'Channel onboarded but its channel-point rewards could not be bound - redemptions stay unmanaged until restart'
            );
        }

        try {
            await this.options.reconcile();
        } catch (err) {
            // Reconciliation converges; a failure here is retried next time.
            logger.error({ channelId: channel.id, err: (err as Error).message }, 'Post-onboarding reconcile failed');
        }

        logger.info(
            { channelId: channel.id, login: channel.twitchLogin, scopes: grant.scopes.length, sessionStarted },
            'Channel onboarded'
        );

        return { channel, missingScopes: missing, sessionStarted };
    }

    /**
     * Records the shared bot account's consent.
     *
     * Consent is global and happens once. What is persisted is the identity and
     * the fact of the grant — the refresh token is kept only so consent can be
     * re-established, and is on no request path.
     */
    async recordBotConsent(identity: ValidatedIdentity, grant: TokenGrant): Promise<{ missingScopes: string[] }> {
        const { db, cipher, logger } = this.options;

        const missing = missingScopes(BOT_SCOPES, grant.scopes);
        if (missing.length > 0) {
            // Fatal in practice rather than merely noisy: without user:read:chat
            // the bot cannot subscribe to chat in ANY channel.
            logger.error(
                { login: identity.login, missing },
                'Bot account consent is missing required scopes - chat will not work until this is re-granted'
            );
        }

        await new BotIdentityRepository(db, cipher).replaceWith({
            twitchUserId: identity.userId,
            twitchLogin: identity.login,
            grantedScopes: grant.scopes,
            refreshToken: grant.refreshToken
        });

        logger.info({ login: identity.login, scopes: grant.scopes.length }, 'Bot identity recorded');

        // The consent is durable at this point, so a failure here degrades to
        // "restart to pick it up" rather than losing the grant.
        try {
            await this.options.onBotIdentityChanged?.();
        } catch (err) {
            logger.error(
                { err: (err as Error).message },
                'Bot identity saved but could not be applied to the running process - restart to pick it up'
            );
        }

        return { missingScopes: missing };
    }
}
