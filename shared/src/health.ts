/**
 * Health contract. Kept in shared because the desktop app surfaces server
 * reachability, and CI/compose healthchecks assert on the same shape.
 */

/** Liveness: is the process up at all. */
export interface HealthResponse {
    status: 'ok';
    /** Process uptime in seconds. */
    uptime: number;
    version: string;
}

/** Readiness: is the process able to serve traffic (dependencies reachable). */
export interface ReadyResponse {
    status: 'ready' | 'not_ready';
    checks: DependencyCheck[];
}

export interface DependencyCheck {
    name: string;
    ok: boolean;
    /** Present only when ok is false. */
    detail?: string;
}
