import type { Logger } from '../logger.js';
import type { ChannelTokenRepository } from '../db/repositories/channelTokenRepository.js';
import { ManualReauthRequiredError, TwitchError } from '../twitch/errors.js';

/**
 * Spotify's authorization-code flow and token lifecycle.
 *
 * Deliberately the same shape as the Twitch onboarding: server-mediated,
 * `state`-protected, tokens encrypted into `channel_tokens` under the
 * `spotify` provider. A second auth model would be a second set of mistakes.
 *
 * The refresh semantics mirror `UserTokenProvider` for the same reasons. They
 * are expiry-based rather than interval-based, with a floor on implausible
 * lifetimes, single-flight, and a distinct manual-reauth error rather than a
 * retry loop.
 *
 * One difference worth knowing: **Spotify does not always return a new refresh
 * token.** Overwriting the stored one with `undefined` would disconnect the
 * channel permanently, so an absent value keeps the existing token.
 */

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * What the bot needs, and nothing more.
 *
 * Reading playback state and adding to the queue need the two `user-modify` /
 * `user-read` playback scopes; playlist writing needs its own. No library or
 * profile access is requested, because none is used.
 */
export const SPOTIFY_SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-modify-public',
    'playlist-modify-private'
] as const;

const SAFETY_MARGIN_MS = 5 * 60_000;
const MIN_LIFETIME_MS = 10 * 60_000;

export interface SpotifyOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export interface SpotifyGrant {
    accessToken: string;
    refreshToken: string | null;
    expiresInSeconds: number;
    scopes: string[];
}

export function buildSpotifyAuthorizeUrl(config: SpotifyOAuthConfig, state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
    url.searchParams.set('state', state);
    // Forces the consent screen, so reconnecting a different account works
    // rather than silently reusing the browser's existing session.
    url.searchParams.set('show_dialog', 'true');

    return url.toString();
}

/** Spotify wants the client credentials as HTTP Basic on the token endpoint. */
function basicAuth(config: SpotifyOAuthConfig): string {
    return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

export async function exchangeSpotifyCode(
    config: SpotifyOAuthConfig,
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<SpotifyGrant> {
    const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
            authorization: basicAuth(config),
            'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.redirectUri
        }).toString()
    });

    const raw = await response.text();
    let parsed: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error_description?: string;
    };
    try {
        parsed = JSON.parse(raw) as typeof parsed;
    } catch {
        throw new TwitchError(`Spotify code exchange returned ${response.status} with a non-JSON body`);
    }

    if (!response.ok || !parsed.access_token) {
        // Spotify's message only; the request carried the code and the secret.
        throw new TwitchError(
            `Spotify code exchange failed with ${response.status}: ${parsed.error_description ?? 'no token returned'}`
        );
    }

    return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? null,
        expiresInSeconds: parsed.expires_in ?? 0,
        scopes: parsed.scope ? parsed.scope.split(' ') : []
    };
}

export interface SpotifyTokenProviderOptions {
    config: SpotifyOAuthConfig;
    channelId: string;
    repository: ChannelTokenRepository;
    logger: Logger;
    fetchImpl?: typeof fetch;
    now?: () => number;
}

export class SpotifyTokenProvider {
    private readonly options: SpotifyTokenProviderOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private inFlight: Promise<string> | null = null;

    constructor(options: SpotifyTokenProviderOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => Date.now());
    }

    /** @throws {ManualReauthRequiredError} when only the broadcaster can fix it. */
    async get(): Promise<string> {
        const stored = await this.options.repository.get('spotify');
        if (!stored) {
            throw new ManualReauthRequiredError('spotify', this.options.channelId);
        }

        const remaining = stored.expiresAt ? stored.expiresAt.getTime() - this.now() : 0;
        if (stored.expiresAt && remaining > SAFETY_MARGIN_MS) {
            return stored.accessToken;
        }

        return this.refresh();
    }

    async refresh(): Promise<string> {
        // Concurrent callers join one refresh: the playback monitor and a chat
        // command can easily collide, and two refreshes race to persist.
        if (this.inFlight) return this.inFlight;

        this.inFlight = this.performRefresh().finally(() => {
            this.inFlight = null;
        });

        return this.inFlight;
    }

    private async performRefresh(): Promise<string> {
        const o = this.options;
        const stored = await o.repository.get('spotify');
        if (!stored) throw new ManualReauthRequiredError('spotify', o.channelId);

        const response = await this.fetchImpl(TOKEN_URL, {
            method: 'POST',
            headers: {
                authorization: basicAuth(o.config),
                'content-type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: stored.refreshToken
            }).toString()
        });

        const raw = await response.text();
        let parsed: {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            error?: string;
        };
        try {
            parsed = JSON.parse(raw) as typeof parsed;
        } catch {
            throw new TwitchError(`Spotify refresh returned ${response.status} with a non-JSON body`);
        }

        if (!parsed.access_token) {
            if (response.status === 400 || parsed.error === 'invalid_grant') {
                o.logger.error(
                    { channelId: o.channelId },
                    'MANUAL RE-AUTHORIZATION REQUIRED - Spotify refresh token is no longer valid'
                );
                throw new ManualReauthRequiredError('spotify', o.channelId);
            }
            throw new TwitchError(`Spotify refresh failed with ${response.status}`);
        }

        const lifetimeMs = Math.max((parsed.expires_in ?? 0) * 1000, MIN_LIFETIME_MS);

        await o.repository.upsert('spotify', {
            accessToken: parsed.access_token,
            // Spotify frequently omits a new refresh token. Writing `undefined`
            // here would disconnect the channel permanently, so the existing
            // one is kept when none is returned.
            refreshToken: parsed.refresh_token ?? stored.refreshToken,
            expiresAt: new Date(this.now() + lifetimeMs),
            scopes: stored.scopes
        });

        o.logger.info(
            { channelId: o.channelId, expiresInMinutes: Math.round(lifetimeMs / 60_000) },
            'Spotify token refreshed'
        );

        return parsed.access_token;
    }
}
