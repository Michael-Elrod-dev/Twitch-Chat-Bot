import type { Response, NextFunction, RequestHandler } from 'express';
import { apiFailure } from '@almosthadai/shared';
import type { ApiRequest } from './middleware.js';

/**
 * Per-principal sliding-window rate limiting.
 *
 * Keyed on the authenticated principal — a user or an API key — rather than an
 * IP address. Behind Caddy every request shares one source address, so an
 * IP-keyed limiter would either throttle the whole tenancy at once or trust a
 * forwarded header the client controls. The credential is the thing we actually
 * verified, so it is the thing to count.
 *
 * A sliding window rather than fixed buckets: a fixed window lets a caller
 * spend the whole budget at 0:59 and the whole budget again at 1:01, which is
 * twice the intended rate at exactly the moment a runaway client produces it.
 *
 * In-process, which is correct for one server and stated plainly as a limit:
 * a second instance would give each its own budget. Redis-backed counting is
 * the move when that day comes, and Redis is already in the tree.
 */

export interface RateLimitOptions {
    windowMs: number;
    max: number;
    /** Distinguishes limiter instances so a read budget cannot spend a write one. */
    bucket?: string;
    now?: () => number;
}

interface Window {
    /** Timestamps of requests still inside the window, oldest first. */
    hits: number[];
}

export class RateLimiter {
    private readonly windowMs: number;
    private readonly max: number;
    private readonly now: () => number;
    private readonly windows = new Map<string, Window>();

    /** Last sweep, so cleanup cost is amortised rather than per request. */
    private lastSweep = 0;

    constructor(options: RateLimitOptions) {
        this.windowMs = options.windowMs;
        this.max = options.max;
        this.now = options.now ?? (() => Date.now());
    }

    /**
     * @returns whether the request is allowed, and what to tell the caller.
     */
    check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
        const now = this.now();
        const cutoff = now - this.windowMs;

        this.sweep(now, cutoff);

        const window = this.windows.get(key) ?? { hits: [] };

        // Hits are appended in time order, so dropping the expired prefix is a
        // single scan from the front rather than a filter of the whole array.
        let expired = 0;
        while (expired < window.hits.length && (window.hits[expired] as number) <= cutoff) expired++;
        if (expired > 0) window.hits.splice(0, expired);

        if (window.hits.length >= this.max) {
            const oldest = window.hits[0] as number;
            this.windows.set(key, window);
            return {
                allowed: false,
                remaining: 0,
                // When the oldest hit falls out of the window, one slot frees.
                retryAfterMs: Math.max(1, oldest + this.windowMs - now)
            };
        }

        window.hits.push(now);
        this.windows.set(key, window);

        return { allowed: true, remaining: this.max - window.hits.length, retryAfterMs: 0 };
    }

    /** Drops principals that have gone quiet, so the map cannot grow forever. */
    private sweep(now: number, cutoff: number): void {
        if (now - this.lastSweep < this.windowMs) return;
        this.lastSweep = now;

        for (const [key, window] of this.windows) {
            if (window.hits.length === 0 || (window.hits[window.hits.length - 1] as number) <= cutoff) {
                this.windows.delete(key);
            }
        }
    }

    get trackedPrincipals(): number {
        return this.windows.size;
    }
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
    const limiter = new RateLimiter(options);
    const bucket = options.bucket ?? 'default';

    return function rateLimit(req: ApiRequest, res: Response, next: NextFunction): void {
        // An unauthenticated request has no principal to count; the auth
        // middleware rejects it a moment later anyway.
        const principal = req.principal;
        if (!principal) {
            next();
            return;
        }

        const result = limiter.check(`${bucket}:${principal}`);

        res.setHeader('RateLimit-Limit', String(options.max));
        res.setHeader('RateLimit-Remaining', String(result.remaining));

        if (!result.allowed) {
            const seconds = Math.ceil(result.retryAfterMs / 1000);
            res.setHeader('Retry-After', String(seconds));
            res.status(429).json(apiFailure(
                'rate_limited',
                `Too many requests. Try again in ${seconds}s.`
            ));
            return;
        }

        next();
    };
}
