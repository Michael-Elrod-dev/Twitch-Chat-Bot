import { Router } from 'express';
import type { HealthResponse, ReadyResponse, DependencyCheck } from '@almosthadai/shared';

/** A dependency the server needs before it can serve real traffic. */
export interface ReadinessProbe {
    name: string;
    check: () => Promise<void>;
}

export interface HealthRouterOptions {
    version: string;
    probes?: ReadinessProbe[];
    /** Injectable for deterministic tests. */
    uptime?: () => number;
}

/**
 * /healthz  - liveness. Cheap, dependency-free: "is this process alive".
 *             A failing dependency must NOT fail this, or an orchestrator would
 *             restart a healthy process because Postgres blinked.
 * /readyz   - readiness. Runs the probes: "should traffic be routed here".
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
    const { version, probes = [], uptime = () => process.uptime() } = options;
    const router = Router();

    router.get('/healthz', (_req, res) => {
        const body: HealthResponse = {
            status: 'ok',
            uptime: Math.floor(uptime()),
            version
        };
        res.status(200).json(body);
    });

    router.get('/readyz', async (_req, res) => {
        const checks: DependencyCheck[] = await Promise.all(
            probes.map(async (probe): Promise<DependencyCheck> => {
                try {
                    await probe.check();
                    return { name: probe.name, ok: true };
                } catch (error) {
                    return {
                        name: probe.name,
                        ok: false,
                        detail: error instanceof Error ? error.message : String(error)
                    };
                }
            })
        );

        const ready = checks.every((check) => check.ok);
        const body: ReadyResponse = { status: ready ? 'ready' : 'not_ready', checks };

        res.status(ready ? 200 : 503).json(body);
    });

    return router;
}
