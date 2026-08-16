import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiter, createRateLimit } from './rateLimit.js';
import type { ApiRequest } from './middleware.js';

describe('RateLimiter', () => {
    const build = (max: number, windowMs: number, clock: { now: number }): RateLimiter =>
        new RateLimiter({ max, windowMs, now: () => clock.now });

    it('allows up to the limit', () => {
        const clock = { now: 1_000 };
        const limiter = build(3, 60_000, clock);

        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('a').allowed).toBe(false);
    });

    it('counts each principal separately', () => {
        // One noisy client must not throttle another tenant.
        const clock = { now: 1_000 };
        const limiter = build(1, 60_000, clock);

        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('a').allowed).toBe(false);
        expect(limiter.check('b').allowed).toBe(true);
    });

    it('reports how long until a slot frees', () => {
        const clock = { now: 1_000 };
        const limiter = build(1, 60_000, clock);

        limiter.check('a');
        clock.now += 20_000;
        const denied = limiter.check('a');

        // 60s window, 20s elapsed since the only hit: 40s remain.
        expect(denied.retryAfterMs).toBe(40_000);
    });

    describe('the window slides', () => {
        it('frees slots one at a time as they age out', () => {
            const clock = { now: 0 };
            const limiter = build(2, 1_000, clock);

            limiter.check('a');            // t=0
            clock.now = 500;
            limiter.check('a');            // t=500
            expect(limiter.check('a').allowed).toBe(false);

            // The t=0 hit ages out here, freeing exactly one slot.
            clock.now = 1_001;
            expect(limiter.check('a').allowed).toBe(true);
            expect(limiter.check('a').allowed).toBe(false);
        });

        it('does not allow a double burst at a boundary', () => {
            // The reason for a sliding window rather than fixed buckets: a
            // fixed window lets a caller spend the whole budget at 0:59 and the
            // whole budget again at 1:01 - twice the intended rate at exactly
            // the moment a runaway client produces it.
            const clock = { now: 0 };
            const limiter = build(5, 1_000, clock);

            for (let i = 0; i < 5; i++) {
                clock.now = 900 + i;
                expect(limiter.check('burst').allowed).toBe(true);
            }

            clock.now = 1_001;
            // A fixed-window limiter would reset here and allow five more.
            expect(limiter.check('burst').allowed).toBe(false);
        });
    });

    describe('memory', () => {
        it('forgets principals that have gone quiet', () => {
            const clock = { now: 0 };
            const limiter = build(5, 1_000, clock);

            for (let i = 0; i < 50; i++) limiter.check(`principal-${i}`);
            expect(limiter.trackedPrincipals).toBe(50);

            // Well past the window, and a new request triggers the sweep.
            clock.now = 10_000;
            limiter.check('someone-new');

            expect(limiter.trackedPrincipals).toBe(1);
        });
    });
});

describe('createRateLimit middleware', () => {
    const buildApp = (max: number) => {
        const app = express();
        app.use((req, _res, next) => {
            (req as ApiRequest).principal = (req.headers['x-principal'] as string) ?? undefined;
            next();
        });
        app.use(createRateLimit({ windowMs: 60_000, max, bucket: 'test' }));
        app.get('/thing', (_req, res) => { res.status(200).json({ ok: true }); });
        return app;
    };

    it('answers 429 with the standard envelope once over the limit', async () => {
        const app = buildApp(2);

        await request(app).get('/thing').set('x-principal', 'user:1').expect(200);
        await request(app).get('/thing').set('x-principal', 'user:1').expect(200);

        const denied = await request(app).get('/thing').set('x-principal', 'user:1').expect(429);
        expect(denied.body).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
        expect(denied.headers['retry-after']).toBeTruthy();
    });

    it('advertises the budget on every response', async () => {
        const app = buildApp(5);

        const res = await request(app).get('/thing').set('x-principal', 'user:2').expect(200);

        expect(res.headers['ratelimit-limit']).toBe('5');
        expect(res.headers['ratelimit-remaining']).toBe('4');
    });

    it('does not throttle one principal because of another', async () => {
        const app = buildApp(1);

        await request(app).get('/thing').set('x-principal', 'user:a').expect(200);
        await request(app).get('/thing').set('x-principal', 'user:b').expect(200);
        await request(app).get('/thing').set('x-principal', 'user:a').expect(429);
    });

    it('lets an unauthenticated request through to be rejected by auth', async () => {
        // There is no principal to count yet; the auth middleware refuses it a
        // moment later, and counting by IP would throttle a whole tenancy at
        // once behind the reverse proxy.
        const app = buildApp(1);

        await request(app).get('/thing').expect(200);
        await request(app).get('/thing').expect(200);
    });
});
