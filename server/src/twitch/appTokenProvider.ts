import type { Logger } from '../logger.js';
import { TwitchError } from './errors.js';

/**
 * The application's own access token (client-credentials grant).
 *
 * Two properties matter and both are easy to get wrong:
 *
 *  - **Single-flight.** N concurrent callers finding the token expired must
 *    produce *one* request to Twitch, not N. Without it, a restart under load
 *    stampedes the token endpoint and every caller races to overwrite the cache.
 *  - **A safety margin.** A token that expires in four seconds is functionally
 *    expired; using it means a 401 somewhere downstream instead of a refresh here.
 *
 * The token value itself never leaves this module except through `get()`, and is
 * never logged.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** Refresh this far before actual expiry. */
const SAFETY_MARGIN_MS = 60_000;

/**
 * Twitch reports app tokens as lasting about 60 days, but a nonsense value would
 * park the token permanently inside the margin and turn every call into a
 * refresh, so the lifetime has a floor.
 */
const MIN_LIFETIME_MS = 5 * 60_000;

export interface AppTokenProviderOptions {
    clientId: string;
    clientSecret: string;
    logger: Logger;
    /** Injectable for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
    now?: () => number;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export class AppTokenProvider {
    private readonly options: AppTokenProviderOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    private cached: CachedToken | null = null;
    /** Non-null while a refresh is in flight; every caller awaits this one. */
    private inFlight: Promise<string> | null = null;

    private refreshCount = 0;

    constructor(options: AppTokenProviderOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => Date.now());
    }

    /** How many times Twitch was actually asked. Exposed for the single-flight test. */
    get refreshes(): number {
        return this.refreshCount;
    }

    async get(): Promise<string> {
        const cached = this.cached;
        if (cached && cached.expiresAt - SAFETY_MARGIN_MS > this.now()) {
            return cached.accessToken;
        }

        return this.refresh();
    }

    /** Discards the cached token. Called after a 401, so the retry fetches a new one. */
    invalidate(): void {
        this.cached = null;
    }

    async refresh(): Promise<string> {
        // The whole point: concurrent callers join the request already running.
        if (this.inFlight) return this.inFlight;

        this.inFlight = this.requestToken().finally(() => {
            this.inFlight = null;
        });

        return this.inFlight;
    }

    private async requestToken(): Promise<string> {
        const body = new URLSearchParams({
            client_id: this.options.clientId,
            client_secret: this.options.clientSecret,
            grant_type: 'client_credentials'
        });

        const response = await this.fetchImpl(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        // Read as text first: a non-JSON error page must not turn into a parse
        // error that hides the status.
        const raw = await response.text();
        let parsed: { access_token?: string; expires_in?: number; message?: string };
        try {
            parsed = JSON.parse(raw) as typeof parsed;
        } catch {
            throw new TwitchError(`app token request returned ${response.status} with a non-JSON body`);
        }

        if (!response.ok || !parsed.access_token) {
            // parsed.message is Twitch's text; the request body held the secret
            // and is deliberately not echoed.
            throw new TwitchError(
                `app token request failed with ${response.status}: ${parsed.message ?? 'no access_token in response'}`
            );
        }

        const lifetimeMs = Math.max((parsed.expires_in ?? 0) * 1000, MIN_LIFETIME_MS);
        this.cached = { accessToken: parsed.access_token, expiresAt: this.now() + lifetimeMs };
        this.refreshCount++;

        this.options.logger.info(
            { expiresInMinutes: Math.round(lifetimeMs / 60_000) },
            'Twitch app access token obtained'
        );

        return parsed.access_token;
    }
}
