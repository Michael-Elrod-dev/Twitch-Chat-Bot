import { z } from 'zod';

/**
 * The typed control panel. Phase 0's config.js was the developer's dashboard;
 * this is the same idea with the guarantee that a misconfigured deployment fails
 * at boot with a readable report, rather than at 3am with `undefined` in a URL.
 */

const port = z.coerce.number().int().min(1).max(65535);

/**
 * A deliberately obvious placeholder so `docker compose up` works with no
 * configuration at all. Production refuses to start on it — see loadEnv.
 */
export const DEV_EVENTSUB_SECRET = 'dev-only-eventsub-secret-change-me';

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
    PUBLIC_URL: z.string().url().optional(),

    /**
     * Shared secret Twitch signs webhook deliveries with. Twitch requires
     * 10-100 ASCII characters, so anything outside that range would be rejected
     * at subscription time rather than here - fail at boot instead.
     */
    TWITCH_EVENTSUB_SECRET: z
        .string({ error: 'a webhook signing secret is required' })
        .min(10, 'must be at least 10 characters (Twitch requirement)')
        .max(100, 'must be at most 100 characters (Twitch requirement)')
        .regex(/^[\x20-\x7E]+$/, 'must be printable ASCII (Twitch requirement)')
        .default(DEV_EVENTSUB_SECRET),

    /**
     * How stale a delivery may be before it is refused as a replay.
     *
     * Twitch's own guidance is 10 minutes, and that is not a lazy default: a
     * retried delivery carries the *original* timestamp, so a tight window would
     * reject exactly the redeliveries the retry policy exists to make.
     */
    EVENTSUB_MAX_SKEW_SECONDS: z.coerce.number().int().min(1).max(3600).default(600),

    /** Twitch user id of the shared bot account, when the DB has no bot_identity row yet. */
    BOT_TWITCH_USER_ID: z.string().min(1).optional(),

    /** Comma-separated names the AI answers to. Defaults to the bot's own login. */
    AI_TRIGGERS: z.string().min(1).optional()
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

    const crossFieldIssues: string[] = [];

    // Cross-field rule: Twitch will not deliver webhooks to a non-TLS callback,
    // so a production deployment advertising http:// is misconfigured.
    if (env.NODE_ENV === 'production' && env.PUBLIC_URL && !env.PUBLIC_URL.startsWith('https://')) {
        crossFieldIssues.push('PUBLIC_URL: must be https:// in production (Twitch requires TLS for EventSub callbacks)');
    }

    // The dev secret is committed and therefore public. Shipping it would let
    // anyone forge a signed event, which is the whole threat the HMAC prevents.
    if (env.NODE_ENV === 'production' && env.TWITCH_EVENTSUB_SECRET === DEV_EVENTSUB_SECRET) {
        crossFieldIssues.push('TWITCH_EVENTSUB_SECRET: the development default must not be used in production');
    }

    if (crossFieldIssues.length > 0) {
        throw new ConfigError(crossFieldIssues);
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
