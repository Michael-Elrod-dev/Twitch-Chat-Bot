import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from './app.js';
import type { ReadinessProbe } from './health.js';

const logger = pino({ level: 'silent' });

const buildApp = (probes: ReadinessProbe[] = []) =>
    createApp({ logger, version: '1.2.3', probes });

describe('GET /healthz - liveness', () => {
    it('reports ok with version and uptime', async () => {
        const res = await request(buildApp()).get('/healthz');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', version: '1.2.3' });
        expect(typeof res.body.uptime).toBe('number');
    });

    it('stays ok even when a dependency is down', async () => {
        // Liveness must not depend on Postgres: an orchestrator would otherwise
        // restart a perfectly healthy process because the database blinked.
        const app = buildApp([
            { name: 'postgres', check: () => Promise.reject(new Error('connection refused')) }
        ]);

        const res = await request(app).get('/healthz');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('needs no authentication', async () => {
        const res = await request(buildApp()).get('/healthz');

        expect(res.status).not.toBe(401);
    });
});

describe('GET /readyz - readiness', () => {
    it('is ready with no probes registered', async () => {
        // Correct today: the chassis has no dependencies until P1-WP3 adds them.
        const res = await request(buildApp()).get('/readyz');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ready', checks: [] });
    });

    it('is ready when every probe passes', async () => {
        const app = buildApp([
            { name: 'postgres', check: () => Promise.resolve() },
            { name: 'redis', check: () => Promise.resolve() }
        ]);

        const res = await request(app).get('/readyz');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ready');
        expect(res.body.checks).toEqual([
            { name: 'postgres', ok: true },
            { name: 'redis', ok: true }
        ]);
    });

    it('returns 503 when any probe fails', async () => {
        const app = buildApp([
            { name: 'postgres', check: () => Promise.resolve() },
            { name: 'redis', check: () => Promise.reject(new Error('ECONNREFUSED')) }
        ]);

        const res = await request(app).get('/readyz');

        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
    });

    it('names the failing dependency and why', async () => {
        const app = buildApp([
            { name: 'postgres', check: () => Promise.reject(new Error('password authentication failed')) }
        ]);

        const res = await request(app).get('/readyz');

        expect(res.body.checks).toEqual([
            { name: 'postgres', ok: false, detail: 'password authentication failed' }
        ]);
    });

    it('runs every probe even after one fails', async () => {
        const second = vi.fn().mockResolvedValue(undefined);
        const app = buildApp([
            { name: 'first', check: () => Promise.reject(new Error('down')) },
            { name: 'second', check: second }
        ]);

        await request(app).get('/readyz');

        // A short-circuit would hide the true state of everything after the first failure.
        expect(second).toHaveBeenCalled();
    });

    it('handles a probe that throws a non-Error', async () => {
        const app = buildApp([
            { name: 'odd', check: () => Promise.reject('just a string') }
        ]);

        const res = await request(app).get('/readyz');

        expect(res.status).toBe(503);
        expect(res.body.checks[0].detail).toBe('just a string');
    });
});

describe('app defaults', () => {
    it('returns a structured 404 for unknown routes', async () => {
        const res = await request(buildApp()).get('/nope');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false, error: { code: 'not_found', message: 'Endpoint not found' } });
    });

    it('does not advertise the framework', async () => {
        const res = await request(buildApp()).get('/healthz');

        expect(res.headers['x-powered-by']).toBeUndefined();
    });
});
