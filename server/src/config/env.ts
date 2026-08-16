import { z } from 'zod';

/**
 * The typed control panel. Phase 0's config.js was the developer's dashboard;
 * this is the same idea with the guarantee that a misconfigured deployment fails
 * at boot with a readable report, rather than at 3am with `undefined` in a URL.
 */

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** Port the HTTP server binds. */
    PORT: port.default(3000),

    /** Postgres connection string. Location-agnostic by design (see PHASE1_DESIGN §4.1 guardrail 1). */
    DATABASE_URL: z.string({ error: 'a Postgres connection string is required' }).min(1),

    /** Redis connection string. */
    REDIS_URL: z.string({ error: 'a Redis connection string is required' }).min(1),

    /** Pool size. Guardrail 6: tuned here, never assumed at call sites. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Public origin the server is reachable at, used to build the EventSub
     * webhook callback URL. Must be HTTPS in production: Twitch requires TLS on
     * port 443 for webhook callbacks.
     */
    PUBLIC_URL: z.string().url().optional()
});

export type Env = z.infer<typeof envSchema>;

/**
 * The subset a database-only entry point needs. Migration and seed scripts have
 * no business demanding a Redis URL they never open - each entry point should
 * fail on exactly the configuration it uses, and nothing more.
 */
const databaseEnvSchema = envSchema.pick({ DATABASE_URL: true, DATABASE_POOL_MAX: true });

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export class ConfigError extends Error {
    public readonly issues: string[];

    constructor(issues: string[]) {
        super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
        this.name = 'ConfigError';
        this.issues = issues;
    }
}

/**
 * Parses and validates the environment.
 *
 * @throws {ConfigError} listing every problem at once - a deployment with three
 * missing variables should learn all three on the first attempt, not one per restart.
 */
/**
 * Shells, Docker Compose and CI all render an unset variable as an empty string
 * rather than omitting it, so `FOO=` must mean "not set" — otherwise an optional
 * field fails validation for a variable nobody actually configured.
 */
function stripEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(source).filter(([, value]) => value !== '')
    );
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
    const parsed = envSchema.safeParse(stripEmpty(source));

    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => {
            const key = issue.path.join('.') || '(root)';
            return `${key}: ${issue.message}`;
        });
        throw new ConfigError(issues);
    }

    const env = parsed.data;

    // Cross-field rule: Twitch will not deliver webhooks to a non-TLS callback,
    // so a production deployment advertising http:// is misconfigured.
    if (env.NODE_ENV === 'production' && env.PUBLIC_URL && !env.PUBLIC_URL.startsWith('https://')) {
        throw new ConfigError(['PUBLIC_URL: must be https:// in production (Twitch requires TLS for EventSub callbacks)']);
    }

    return env;
}

/** @throws {ConfigError} listing every problem at once, as loadEnv does. */
export function loadDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
    const parsed = databaseEnvSchema.safeParse(stripEmpty(source));

    if (!parsed.success) {
        throw new ConfigError(
            parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        );
    }

    return parsed.data;
}

export function isProduction(env: Env): boolean {
    return env.NODE_ENV === 'production';
}
