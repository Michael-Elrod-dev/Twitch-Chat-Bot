import type { Logger } from '../logger.js';
import { TwitchError } from './errors.js';

/**
 * Twitch's authorization-code flow.
 *
 * PKCE is not available at Twitch (docs/TWITCH_PLATFORM_FACTS.md section 5.2), so the
 * secret-holding server mediates every flow, including the desktop app's, which
 * is never an OAuth client itself.
 */

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/**
 * What a broadcaster grants when connecting their channel.
 *
 * `channel:read:redemptions` and `channel:manage:redemptions` are both requested
 * because neither is documented as a superset of the other, and losing the read
 * scope would silently stop redemption events. Collapse to one only with
 * evidence.
 *
 * Nothing here is speculative. Twitch warns that over-requesting can get an
 * application suspended, so every scope below maps to a specific call.
 */
export const CHANNEL_SCOPES = [
    'channel:bot',                  // lets the shared bot read and write in this chat
    'channel:read:redemptions',     // redemption events
    'channel:manage:redemptions',   // update redemption status - the refund path
    'moderator:read:followers',     // follow events (broadcaster as their own moderator)
    'moderator:read:chatters'       // the viewer-presence poll
] as const;

/** What the shared bot account grants once, globally. */
export const BOT_SCOPES = [
    'user:read:chat',   // receive channel.chat.message
    'user:write:chat',  // send via the Helix chat API
    'user:bot'          // marks this account as a bot for the app-token model
] as const;

/**
 * Signing in to the desktop app proves identity and nothing more.
 *
 * Deliberately empty: Twitch returns the user's id from `/oauth2/userinfo` (or
 * the validate endpoint) without any scope, so requesting one would be asking
 * for access the app does not use.
 */
export const SIGN_IN_SCOPES: readonly string[] = [];

export type OAuthFlow = 'channel' | 'bot' | 'signin';

export const FLOW_SCOPES: Record<OAuthFlow, readonly string[]> = {
    channel: CHANNEL_SCOPES,
    bot: BOT_SCOPES,
    signin: SIGN_IN_SCOPES
};

export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export interface TokenGrant {
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
    scopes: string[];
}

export interface ValidatedIdentity {
    userId: string;
    login: string;
    scopes: string[];
    expiresInSeconds: number;
}

/**
 * @param state opaque CSRF value; the callback refuses anything it did not issue.
 * @param forceVerify makes Twitch re-prompt even for an already-granted app,
 * which is what lets the bot account and the owner authorize from one browser
 * without the second consent silently reusing the first session.
 */
export function buildAuthorizeUrl(
    config: OAuthConfig,
    flow: OAuthFlow,
    state: string,
    forceVerify = true
): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', FLOW_SCOPES[flow].join(' '));
    url.searchParams.set('state', state);
    if (forceVerify) url.searchParams.set('force_verify', 'true');

    return url.toString();
}

export interface OAuthClientOptions {
    config: OAuthConfig;
    logger: Logger;
    fetchImpl?: typeof fetch;
}

export class TwitchOAuthClient {
    private readonly config: OAuthConfig;
    private readonly logger: Logger;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OAuthClientOptions) {
        this.config = options.config;
        this.logger = options.logger;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    authorizeUrl(flow: OAuthFlow, state: string): string {
        return buildAuthorizeUrl(this.config, flow, state);
    }

    /**
     * Exchanges an authorization code for tokens.
     *
     * The code is single-use and short-lived, and it is never logged: it is a
     * bearer credential until the moment it is spent.
     */
    async exchangeCode(code: string): Promise<TokenGrant> {
        const body = new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: this.config.redirectUri
        });

        const response = await this.fetchImpl(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        const raw = await response.text();
        let parsed: {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            scope?: string[];
            message?: string;
        };
        try {
            parsed = JSON.parse(raw) as typeof parsed;
        } catch {
            throw new TwitchError(`code exchange returned ${response.status} with a non-JSON body`);
        }

        if (!response.ok || !parsed.access_token || !parsed.refresh_token) {
            // Twitch's message only; the request carried the code and the secret.
            throw new TwitchError(`code exchange failed with ${response.status}: ${parsed.message ?? 'no tokens returned'}`);
        }

        this.logger.info({ scopes: parsed.scope?.length ?? 0 }, 'Authorization code exchanged');

        return {
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token,
            expiresInSeconds: parsed.expires_in ?? 0,
            scopes: parsed.scope ?? []
        };
    }

    /**
     * Identifies the token's owner.
     *
     * `/oauth2/validate` returns the user id, login and granted scopes for any
     * user token, with no scope of its own, which is what makes a zero-scope
     * sign-in flow possible.
     */
    async validate(accessToken: string): Promise<ValidatedIdentity> {
        const response = await this.fetchImpl('https://id.twitch.tv/oauth2/validate', {
            headers: { authorization: `OAuth ${accessToken}` }
        });

        const raw = await response.text();
        if (!response.ok) {
            throw new TwitchError(`token validation failed with ${response.status}`);
        }

        const parsed = JSON.parse(raw) as {
            user_id?: string;
            login?: string;
            scopes?: string[];
            expires_in?: number;
        };

        if (!parsed.user_id) {
            throw new TwitchError('token validation returned no user id');
        }

        return {
            userId: parsed.user_id,
            login: parsed.login ?? '',
            scopes: parsed.scopes ?? [],
            expiresInSeconds: parsed.expires_in ?? 0
        };
    }

    /** Best-effort revocation, used when a flow is abandoned partway through. */
    async revoke(accessToken: string): Promise<void> {
        try {
            await this.fetchImpl('https://id.twitch.tv/oauth2/revoke', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: this.config.clientId, token: accessToken }).toString()
            });
        } catch (err) {
            this.logger.warn({ err: (err as Error).message }, 'Could not revoke token');
        }
    }
}

/** @returns the scopes that were requested but not granted. */
export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
    const have = new Set(granted);
    return requested.filter((scope) => !have.has(scope));
}
