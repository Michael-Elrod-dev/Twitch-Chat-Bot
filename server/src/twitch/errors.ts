/**
 * Twitch failure modes, as distinct types.
 *
 * The distinction that matters most is "retry this" versus "a human has to go
 * and click something". Phase 0 learned that the hard way: a dead refresh token
 * produced the same generic error as a network blip, so the bot retried forever
 * and nobody noticed it had been disconnected until a stream went quiet.
 */

/** Base class, so a caller can catch everything from this layer at once. */
export class TwitchError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TwitchError';
    }
}

/**
 * The refresh token is dead. Nothing the process can do will fix it — the user
 * has to re-authorize.
 *
 * Logged at error level with the channel named, never retried in a loop.
 */
export class ManualReauthRequiredError extends TwitchError {
    readonly channelId: string | undefined;
    readonly subject: string;

    constructor(subject: string, channelId?: string) {
        super(
            `MANUAL RE-AUTHORIZATION REQUIRED for ${subject}` +
            (channelId ? ` (channel ${channelId})` : '') +
            ' - the refresh token is no longer valid'
        );
        this.name = 'ManualReauthRequiredError';
        this.subject = subject;
        this.channelId = channelId;
    }
}

/** A non-2xx from Helix. Carries the status so callers can branch on 401 or 404. */
export class HelixError extends TwitchError {
    readonly status: number;
    readonly endpoint: string;
    /** Twitch's own message, which never contains our credentials. */
    readonly twitchMessage: string;

    constructor(endpoint: string, status: number, twitchMessage: string) {
        super(`Helix ${endpoint} failed with ${status}: ${twitchMessage || 'no message'}`);
        this.name = 'HelixError';
        this.status = status;
        this.endpoint = endpoint;
        this.twitchMessage = twitchMessage;
    }
}

/** 429. Carries when it is worth trying again. */
export class RateLimitedError extends TwitchError {
    readonly retryAfterMs: number;
    readonly endpoint: string;

    constructor(endpoint: string, retryAfterMs: number) {
        super(`Helix ${endpoint} rate limited; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        this.name = 'RateLimitedError';
        this.endpoint = endpoint;
        this.retryAfterMs = retryAfterMs;
    }
}

/** Raised when a live path is reached without the credentials it needs. */
export class TwitchNotConfiguredError extends TwitchError {
    constructor(what: string) {
        super(`${what} requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET`);
        this.name = 'TwitchNotConfiguredError';
    }
}
