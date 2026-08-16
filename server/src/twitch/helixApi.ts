import type { Logger } from '../logger.js';
import type { AppTokenProvider } from './appTokenProvider.js';
import { HelixError, RateLimitedError } from './errors.js';
import type {
    CreateSubscriptionInput,
    EventSubSubscription,
    HelixClient
} from '../transport/eventsub/helixClient.js';

/**
 * The real Helix client.
 *
 * Everything the bot does to Twitch goes through one request method, so the
 * cross-cutting rules — bearer token, 401-retry-once, 429 respect, never logging
 * a credential — are implemented once rather than per endpoint.
 */

const HELIX_BASE = 'https://api.twitch.tv/helix';

/**
 * Twitch's documented subscription-creation limit is 100/minute. Spacing creates
 * is the WP5 flag closed: at two channels it is irrelevant, at fifty a bulk
 * re-subscribe would otherwise burst straight through the budget.
 */
const DEFAULT_CREATE_SPACING_MS = 750;

/** A 429 with no usable header still needs *some* delay, or the retry is instant. */
const FALLBACK_RATE_LIMIT_MS = 5_000;

export interface HelixApiOptions {
    clientId: string;
    appTokens: AppTokenProvider;
    logger: Logger;
    fetchImpl?: typeof fetch;
    createSpacingMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface HelixUser {
    id: string;
    login: string;
    displayName: string;
}

export interface HelixStream {
    id: string;
    userId: string;
    startedAt: string;
    title: string;
    gameName: string;
}

export interface CustomReward {
    id: string;
    title: string;
    cost: number;
    isEnabled: boolean;
}

interface RequestOptions {
    method?: string;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
    /** Overrides the app token — used for the endpoints that demand a user token. */
    userAccessToken?: string;
    /** Suppresses the 401 retry, so the retry itself cannot recurse. */
    isRetry?: boolean;
}

export class HelixApi implements HelixClient {
    private readonly options: HelixApiOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly createSpacingMs: number;

    /** Timestamp of the last subscription create, for spacing. */
    private lastCreateAt = 0;
    /** Serialises creates so concurrent callers cannot both skip the spacing. */
    private createChain: Promise<unknown> = Promise.resolve();

    constructor(options: HelixApiOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? (() => Date.now());
        this.createSpacingMs = options.createSpacingMs ?? DEFAULT_CREATE_SPACING_MS;
    }

    // ---- EventSub subscriptions (the WP5 HelixClient contract) ---------------

    async listEventSubSubscriptions(): Promise<EventSubSubscription[]> {
        const collected: EventSubSubscription[] = [];
        let cursor: string | undefined;

        // Paginated deliberately: a partial list would look like a pile of
        // missing subscriptions and the reconciler would recreate every one.
        do {
            const page = await this.request<{
                data: EventSubSubscription[];
                pagination?: { cursor?: string };
            }>('/eventsub/subscriptions', { query: cursor === undefined ? {} : { after: cursor } });

            collected.push(...(page.data ?? []));
            cursor = page.pagination?.cursor;
        } while (cursor);

        return collected;
    }

    async createEventSubSubscription(input: CreateSubscriptionInput): Promise<EventSubSubscription> {
        // Chained rather than merely delayed: two concurrent creates would each
        // read the same lastCreateAt and both decide no wait was needed.
        const run = this.createChain.then(async () => {
            const sinceLast = this.now() - this.lastCreateAt;
            if (this.lastCreateAt !== 0 && sinceLast < this.createSpacingMs) {
                await this.sleep(this.createSpacingMs - sinceLast);
            }
            this.lastCreateAt = this.now();

            const response = await this.request<{ data: EventSubSubscription[] }>('/eventsub/subscriptions', {
                method: 'POST',
                body: input
            });

            const created = response.data?.[0];
            if (!created) {
                throw new HelixError('/eventsub/subscriptions', 200, 'create returned no subscription');
            }
            return created;
        });

        // The chain must keep advancing even when a create fails, or one failure
        // would deadlock every subsequent create behind a rejected promise.
        this.createChain = run.catch(() => undefined);
        return run;
    }

    async deleteEventSubSubscription(id: string): Promise<void> {
        await this.request('/eventsub/subscriptions', { method: 'DELETE', query: { id } });
    }

    // ---- Chat ---------------------------------------------------------------

    /**
     * @returns whether Twitch accepted the message for delivery. A message can be
     * accepted-but-dropped (AutoMod), which is reported rather than thrown.
     */
    async sendChatMessage(broadcasterId: string, senderId: string, message: string): Promise<{
        sent: boolean;
        dropReason?: string;
    }> {
        const response = await this.request<{
            data: { message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } }[];
        }>('/chat/messages', {
            method: 'POST',
            body: { broadcaster_id: broadcasterId, sender_id: senderId, message }
        });

        const result = response.data?.[0];
        if (!result) return { sent: false, dropReason: 'no result returned' };

        return result.is_sent
            ? { sent: true }
            : { sent: false, dropReason: result.drop_reason?.message ?? result.drop_reason?.code ?? 'unknown' };
    }

    // ---- Users, streams, chatters ------------------------------------------

    async getUsers(logins: string[] = [], ids: string[] = []): Promise<HelixUser[]> {
        const response = await this.request<{
            data: { id: string; login: string; display_name: string }[];
        }>('/users', { query: { login: logins, id: ids } });

        return (response.data ?? []).map((u) => ({ id: u.id, login: u.login, displayName: u.display_name }));
    }

    async getStream(broadcasterId: string): Promise<HelixStream | null> {
        const response = await this.request<{
            data: { id: string; user_id: string; started_at: string; title: string; game_name: string }[];
        }>('/streams', { query: { user_id: broadcasterId } });

        const stream = response.data?.[0];
        if (!stream) return null;

        return {
            id: stream.id,
            userId: stream.user_id,
            startedAt: stream.started_at,
            title: stream.title,
            gameName: stream.game_name
        };
    }

    /**
     * Requires a moderator-scoped **user** token (`moderator:read:chatters`).
     *
     * Returns the login alongside the id: presence writes both, and an id with
     * no name turns every viewer row into an unreadable number.
     */
    async getChatters(
        broadcasterId: string,
        moderatorId: string,
        userAccessToken: string
    ): Promise<{ twitchUserId: string; login: string }[]> {
        const collected: { twitchUserId: string; login: string }[] = [];
        let cursor: string | undefined;

        do {
            const page = await this.request<{
                data: { user_id: string; user_login: string }[];
                pagination?: { cursor?: string };
            }>('/chat/chatters', {
                query: {
                    broadcaster_id: broadcasterId,
                    moderator_id: moderatorId,
                    first: '1000',
                    ...(cursor === undefined ? {} : { after: cursor })
                },
                userAccessToken
            });

            collected.push(...(page.data ?? []).map((c) => ({ twitchUserId: c.user_id, login: c.user_login })));
            cursor = page.pagination?.cursor;
        } while (cursor);

        return collected;
    }

    // ---- Channel point rewards ---------------------------------------------

    /**
     * Custom rewards are the P1-WP3 refund finding made concrete: only rewards
     * **this application created** can have their redemption status updated, so
     * the app creates them at onboarding rather than adopting dashboard-made ones.
     */
    async createCustomReward(
        broadcasterId: string,
        userAccessToken: string,
        reward: { title: string; cost: number; prompt?: string; isUserInputRequired?: boolean }
    ): Promise<CustomReward> {
        const response = await this.request<{
            data: { id: string; title: string; cost: number; is_enabled: boolean }[];
        }>('/channel_points/custom_rewards', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId },
            body: {
                title: reward.title,
                cost: reward.cost,
                ...(reward.prompt === undefined ? {} : { prompt: reward.prompt }),
                is_user_input_required: reward.isUserInputRequired ?? false
            },
            userAccessToken
        });

        const created = response.data?.[0];
        if (!created) throw new HelixError('/channel_points/custom_rewards', 200, 'create returned no reward');

        return { id: created.id, title: created.title, cost: created.cost, isEnabled: created.is_enabled };
    }

    async listCustomRewards(
        broadcasterId: string,
        userAccessToken: string,
        onlyManageable = true
    ): Promise<CustomReward[]> {
        const response = await this.request<{
            data: { id: string; title: string; cost: number; is_enabled: boolean }[];
        }>('/channel_points/custom_rewards', {
            query: {
                broadcaster_id: broadcasterId,
                only_manageable_rewards: onlyManageable ? 'true' : 'false'
            },
            userAccessToken
        });

        return (response.data ?? []).map((r) => ({
            id: r.id, title: r.title, cost: r.cost, isEnabled: r.is_enabled
        }));
    }

    /**
     * Enables or disables a reward.
     *
     * This is what "song requests off" must actually mean: a disabled reward
     * cannot be redeemed at all, so nobody spends points on something the bot
     * will only refund. Flipping a database flag alone would leave the reward
     * visible and redeemable.
     */
    async setCustomRewardEnabled(
        broadcasterId: string,
        userAccessToken: string,
        rewardId: string,
        isEnabled: boolean
    ): Promise<void> {
        await this.request('/channel_points/custom_rewards', {
            method: 'PATCH',
            query: { broadcaster_id: broadcasterId, id: rewardId },
            body: { is_enabled: isEnabled },
            userAccessToken
        });
    }

    async deleteCustomReward(broadcasterId: string, userAccessToken: string, rewardId: string): Promise<void> {
        await this.request('/channel_points/custom_rewards', {
            method: 'DELETE',
            query: { broadcaster_id: broadcasterId, id: rewardId },
            userAccessToken
        });
    }

    /** The refund path. `CANCELED` returns the viewer's points. */
    async updateRedemptionStatus(
        broadcasterId: string,
        userAccessToken: string,
        rewardId: string,
        redemptionId: string,
        status: 'FULFILLED' | 'CANCELED'
    ): Promise<void> {
        await this.request('/channel_points/custom_rewards/redemptions', {
            method: 'PATCH',
            query: { broadcaster_id: broadcasterId, reward_id: rewardId, id: redemptionId },
            body: { status },
            userAccessToken
        });
    }

    // ---- The one request path ----------------------------------------------

    private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const token = options.userAccessToken ?? (await this.options.appTokens.get());

        const url = new URL(`${HELIX_BASE}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) {
                if (item !== '') url.searchParams.append(key, item);
            }
        }

        const response = await this.fetchImpl(url.toString(), {
            method: options.method ?? 'GET',
            headers: {
                authorization: `Bearer ${token}`,
                'client-id': this.options.clientId,
                ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
        });

        if (response.status === 429) {
            const retryAfterMs = rateLimitDelayMs(response.headers, this.now());
            // Deliberately not retried in place. A thundering herd of automatic
            // retries is how a rate limit becomes an outage; the caller decides.
            this.options.logger.warn(
                { endpoint: path, retryAfterMs },
                'Helix rate limit hit - backing off'
            );
            throw new RateLimitedError(path, retryAfterMs);
        }

        // An app token can expire early if it is revoked. One retry with a fresh
        // token; a second 401 is a real authorization problem, not a stale token.
        if (response.status === 401 && !options.isRetry && !options.userAccessToken) {
            this.options.logger.warn({ endpoint: path }, 'Helix returned 401 - refreshing the app token and retrying once');
            this.options.appTokens.invalidate();
            return this.request<T>(path, { ...options, isRetry: true });
        }

        if (response.status === 204) {
            return undefined as T;
        }

        const raw = await response.text();

        if (!response.ok) {
            // Twitch's own message only. The bearer token was in the *request*
            // and is never echoed into the error.
            throw new HelixError(path, response.status, extractMessage(raw));
        }

        if (raw === '') return undefined as T;

        try {
            return JSON.parse(raw) as T;
        } catch {
            throw new HelixError(path, response.status, 'response was not valid JSON');
        }
    }
}

/**
 * Twitch sends `Ratelimit-Reset` as a unix timestamp in seconds, and sometimes a
 * conventional `Retry-After` in seconds. Both are honoured; a missing or absurd
 * value falls back rather than producing an instant retry or an hours-long wait.
 */
export function rateLimitDelayMs(headers: Headers, now: number): number {
    const reset = Number(headers.get('ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
        const delay = reset * 1000 - now;
        if (delay > 0 && delay < 60 * 60_000) return delay;
    }

    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter * 1000, 60 * 60_000);
    }

    return FALLBACK_RATE_LIMIT_MS;
}

function extractMessage(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as { message?: string; error?: string };
        return parsed.message ?? parsed.error ?? '';
    } catch {
        // Truncated: an HTML error page should not become a multi-kilobyte log line.
        return raw.slice(0, 200);
    }
}
