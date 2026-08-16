import type { Logger } from '../logger.js';
import type { ChannelTokenRepository } from '../db/repositories/channelTokenRepository.js';
import { ManualReauthRequiredError, TwitchError } from './errors.js';

/**
 * A broadcaster's user access token.
 *
 * Phase 0's tokenManager semantics, ported deliberately rather than rewritten:
 *
 *  - **Expiry-based**, not interval-based. A five-minute check interval used to
 *    mean a five-minute rotation; refreshing only inside the safety margin fixed
 *    that and the fix is worth keeping.
 *  - **A floor on the reported lifetime.** An implausibly short `expires_in`
 *    would park the token permanently inside the margin and restore
 *    rotate-on-every-call.
 *  - **Atomic persist.** Twitch issues a new refresh token on every refresh, so
 *    both halves are written together — a crash between two writes could strand
 *    the channel with a refresh token Twitch has already retired.
 *  - **A loud, distinct error for a dead refresh token.** Retrying that forever
 *    is how Phase 0 stayed quietly disconnected.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

const SAFETY_MARGIN_MS = 10 * 60_000;
const MIN_LIFETIME_MS = 15 * 60_000;

export interface UserTokenProviderOptions {
    clientId: string;
    clientSecret: string;
    channelId: string;
    repository: ChannelTokenRepository;
    logger: Logger;
    fetchImpl?: typeof fetch;
    now?: () => number;
}

interface RefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string[];
    message?: string;
    status?: number;
}

export class UserTokenProvider {
    private readonly options: UserTokenProviderOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    private inFlight: Promise<string> | null = null;

    constructor(options: UserTokenProviderOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => Date.now());
    }

    /**
     * @returns a usable access token, refreshing first if it is inside the margin.
     * @throws {ManualReauthRequiredError} when only the broadcaster can fix it.
     */
    async get(): Promise<string> {
        const stored = await this.options.repository.get('twitch');
        if (!stored) {
            throw new ManualReauthRequiredError('broadcaster token', this.options.channelId);
        }

        if (!this.needsRefresh(stored.expiresAt)) {
            return stored.accessToken;
        }

        return this.refresh();
    }

    /** No recorded expiry means refresh: an unknown expiry is not a valid one. */
    private needsRefresh(expiresAt: Date | null): boolean {
        if (!expiresAt) return true;

        const remaining = expiresAt.getTime() - this.now();
        return remaining <= SAFETY_MARGIN_MS;
    }

    async refresh(): Promise<string> {
        // Concurrent callers join one refresh; two simultaneous refreshes would
        // race, and the loser would persist a refresh token Twitch already
        // invalidated when it issued the winner's.
        if (this.inFlight) return this.inFlight;

        this.inFlight = this.performRefresh().finally(() => {
            this.inFlight = null;
        });

        return this.inFlight;
    }

    private async performRefresh(): Promise<string> {
        const stored = await this.options.repository.get('twitch');
        if (!stored) {
            throw new ManualReauthRequiredError('broadcaster token', this.options.channelId);
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: this.options.clientId,
            client_secret: this.options.clientSecret
        });

        const response = await this.fetchImpl(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        const raw = await response.text();
        let parsed: RefreshResponse;
        try {
            parsed = JSON.parse(raw) as RefreshResponse;
        } catch {
            throw new TwitchError(`token refresh returned ${response.status} with a non-JSON body`);
        }

        if (!parsed.access_token || !parsed.refresh_token) {
            if (isDeadRefreshToken(response.status, parsed)) {
                // Distinct type, not a generic failure: nothing this process does
                // will fix it, so it must never enter a retry loop.
                this.options.logger.error(
                    { channelId: this.options.channelId, twitchStatus: response.status },
                    'MANUAL RE-AUTHORIZATION REQUIRED - broadcaster refresh token is no longer valid'
                );
                throw new ManualReauthRequiredError('broadcaster token', this.options.channelId);
            }

            throw new TwitchError(
                `token refresh failed with ${response.status}: ${parsed.message ?? 'no tokens in response'}`
            );
        }

        const lifetimeMs = Math.max((parsed.expires_in ?? 0) * 1000, MIN_LIFETIME_MS);
        if ((parsed.expires_in ?? 0) * 1000 < MIN_LIFETIME_MS) {
            this.options.logger.warn(
                { channelId: this.options.channelId, reportedSeconds: parsed.expires_in },
                'Twitch reported an implausibly short token lifetime; applying the floor'
            );
        }

        // Both halves in one statement, encrypted on the way in.
        await this.options.repository.upsert('twitch', {
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token,
            expiresAt: new Date(this.now() + lifetimeMs),
            scopes: parsed.scope ?? stored.scopes
        });

        this.options.logger.info(
            { channelId: this.options.channelId, expiresInMinutes: Math.round(lifetimeMs / 60_000) },
            'Broadcaster token refreshed'
        );

        return parsed.access_token;
    }
}

/** Twitch answers a retired refresh token with a 400 and a specific message. */
function isDeadRefreshToken(status: number, parsed: RefreshResponse): boolean {
    return status === 400 || parsed.status === 400 || /invalid refresh token/i.test(parsed.message ?? '');
}
