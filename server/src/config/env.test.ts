import { describe, it, expect } from 'vitest';
import { loadEnv, isProduction, ConfigError, DEV_EVENTSUB_SECRET } from './env.js';

/**
 * The config module's whole job is to fail loudly and completely at boot rather
 * than let a missing variable become `undefined` in a connection string hours
 * later. These tests pin both halves of that: what it accepts, and how it reports
 * what it rejects.
 */

const valid = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/almosthadai',
    REDIS_URL: 'redis://localhost:6379'
} satisfies NodeJS.ProcessEnv;

/**
 * Production refuses the committed development signing secret, so every
 * production case has to carry a real one. Bundling it here keeps that rule from
 * being restated in a dozen places.
 */
const PRODUCTION_SECRET = 'a-genuine-production-eventsub-secret';
const validProduction = {
    ...valid,
    NODE_ENV: 'production',
    TWITCH_EVENTSUB_SECRET: PRODUCTION_SECRET
} satisfies NodeJS.ProcessEnv;

describe('loadEnv - accepted configuration', () => {
    it('accepts a minimal valid environment', () => {
        const env = loadEnv({ ...valid });

        expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
        expect(env.REDIS_URL).toBe(valid.REDIS_URL);
    });

    it('applies defaults for everything optional', () => {
        const env = loadEnv({ ...valid });

        expect(env.NODE_ENV).toBe('development');
        expect(env.PORT).toBe(3000);
        expect(env.LOG_LEVEL).toBe('info');
        expect(env.PUBLIC_URL).toBeUndefined();
    });

    it('coerces PORT from its string environment form', () => {
        const env = loadEnv({ ...valid, PORT: '8080' });

        expect(env.PORT).toBe(8080);
        expect(typeof env.PORT).toBe('number');
    });

    it('accepts each valid NODE_ENV', () => {
        for (const nodeEnv of ['development', 'test', 'production'] as const) {
            const env = loadEnv({ ...validProduction, NODE_ENV: nodeEnv, PUBLIC_URL: 'https://bot.example.com' });
            expect(env.NODE_ENV).toBe(nodeEnv);
        }
    });

    it('accepts each valid LOG_LEVEL', () => {
        for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
            expect(loadEnv({ ...valid, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
        }
    });
});

describe('loadEnv - rejected configuration', () => {
    it('rejects a missing DATABASE_URL', () => {
        expect(() => loadEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(ConfigError);
    });

    it('rejects a missing REDIS_URL', () => {
        expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(ConfigError);
    });

    it('reports EVERY missing variable at once, not just the first', () => {
        // A deployment missing three variables should learn all three on the first
        // attempt rather than discovering them one restart at a time.
        let error: unknown;
        try {
            loadEnv({ PORT: 'not-a-number' });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(ConfigError);
        const issues = (error as ConfigError).issues;

        expect(issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
        expect(issues.some((i) => i.startsWith('REDIS_URL'))).toBe(true);
        expect(issues.some((i) => i.startsWith('PORT'))).toBe(true);
    });

    it('produces a readable multi-line report', () => {
        try {
            loadEnv({});
            expect.unreachable('should have thrown');
        } catch (error) {
            const message = (error as ConfigError).message;
            expect(message).toContain('Invalid environment configuration');
            expect(message).toContain('  - DATABASE_URL');
        }
    });

    it('rejects an out-of-range PORT', () => {
        expect(() => loadEnv({ ...valid, PORT: '0' })).toThrow(ConfigError);
        expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow(ConfigError);
    });

    it('rejects a non-integer PORT', () => {
        expect(() => loadEnv({ ...valid, PORT: '3000.5' })).toThrow(ConfigError);
    });

    it('rejects an unknown NODE_ENV', () => {
        expect(() => loadEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(ConfigError);
    });

    it('rejects a malformed PUBLIC_URL', () => {
        expect(() => loadEnv({ ...valid, PUBLIC_URL: 'not a url' })).toThrow(ConfigError);
    });

    it('rejects an empty DATABASE_URL with a useful message', () => {
        try {
            loadEnv({ ...valid, DATABASE_URL: '' });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as ConfigError).issues.join()).toContain('Postgres connection string');
        }
    });
});

describe('loadEnv - production cross-field rules', () => {
    it('rejects a plaintext PUBLIC_URL in production', () => {
        // Twitch will not deliver EventSub webhooks to a non-TLS callback, so this
        // configuration is broken in a way that would only surface as silence.
        expect(() =>
            loadEnv({ ...validProduction, PUBLIC_URL: 'http://bot.example.com' })
        ).toThrow(/https/);
    });

    it('accepts an https PUBLIC_URL in production', () => {
        const env = loadEnv({ ...validProduction, PUBLIC_URL: 'https://bot.example.com' });

        expect(env.PUBLIC_URL).toBe('https://bot.example.com');
    });

    it('allows a plaintext PUBLIC_URL outside production', () => {
        const env = loadEnv({ ...valid, NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:3000' });

        expect(env.PUBLIC_URL).toBe('http://localhost:3000');
    });

    it('refuses to start production on the committed development secret', () => {
        // The dev default is in the repository and therefore public: shipping it
        // would let anyone forge a signed event, which is the entire threat the
        // HMAC exists to prevent.
        expect(() =>
            loadEnv({ ...valid, NODE_ENV: 'production', TWITCH_EVENTSUB_SECRET: DEV_EVENTSUB_SECRET })
        ).toThrow(/development default/);
    });

    it('allows the development secret outside production', () => {
        const env = loadEnv({ ...valid, TWITCH_EVENTSUB_SECRET: DEV_EVENTSUB_SECRET });

        expect(env.TWITCH_EVENTSUB_SECRET).toBe(DEV_EVENTSUB_SECRET);
    });

    it('reports the https and secret problems together', () => {
        // Both wrong should mean one restart, not two.
        try {
            loadEnv({
                ...valid,
                NODE_ENV: 'production',
                PUBLIC_URL: 'http://bot.example.com',
                TWITCH_EVENTSUB_SECRET: DEV_EVENTSUB_SECRET
            });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as ConfigError).issues).toHaveLength(2);
        }
    });
});

describe('loadEnv - EventSub settings', () => {
    it('defaults the signing secret to the development placeholder', () => {
        expect(loadEnv({ ...valid }).TWITCH_EVENTSUB_SECRET).toBe(DEV_EVENTSUB_SECRET);
    });

    it('enforces the length Twitch requires', () => {
        // Twitch rejects a secret outside 10-100 characters at subscription
        // time; failing at boot is a considerably better place to find out.
        expect(() => loadEnv({ ...valid, TWITCH_EVENTSUB_SECRET: 'short' })).toThrow(ConfigError);
        expect(() => loadEnv({ ...valid, TWITCH_EVENTSUB_SECRET: 'x'.repeat(101) })).toThrow(ConfigError);
        expect(loadEnv({ ...valid, TWITCH_EVENTSUB_SECRET: 'x'.repeat(100) }).TWITCH_EVENTSUB_SECRET).toHaveLength(100);
    });

    it('rejects a non-ASCII secret', () => {
        expect(() => loadEnv({ ...valid, TWITCH_EVENTSUB_SECRET: 'sécret-with-accents' })).toThrow(ConfigError);
    });

    it('defaults the replay window to the ten minutes Twitch documents', () => {
        // Not a lazy default: a retry carries the original timestamp, so a
        // tighter window would reject exactly the redeliveries it should accept.
        expect(loadEnv({ ...valid }).EVENTSUB_MAX_SKEW_SECONDS).toBe(600);
    });

    it('coerces an overridden replay window', () => {
        expect(loadEnv({ ...valid, EVENTSUB_MAX_SKEW_SECONDS: '120' }).EVENTSUB_MAX_SKEW_SECONDS).toBe(120);
    });

    it('splits nothing itself - AI_TRIGGERS stays a raw string here', () => {
        expect(loadEnv({ ...valid, AI_TRIGGERS: 'bot,buddy' }).AI_TRIGGERS).toBe('bot,buddy');
    });
});

describe('isProduction', () => {
    it('is true only for production', () => {
        expect(isProduction(loadEnv({ ...validProduction }))).toBe(true);
        expect(isProduction(loadEnv({ ...valid, NODE_ENV: 'development' }))).toBe(false);
        expect(isProduction(loadEnv({ ...valid, NODE_ENV: 'test' }))).toBe(false);
    });
});

describe('loadEnv - empty-string variables', () => {
    // Compose, shells and CI all render an unset variable as `FOO=` rather than
    // omitting it. Treating that as a present-but-invalid value crash-looped the
    // container on its first real `docker compose up`.
    it('treats an empty optional variable as absent', () => {
        const env = loadEnv({ ...valid, PUBLIC_URL: '' });

        expect(env.PUBLIC_URL).toBeUndefined();
    });

    it('falls back to the default for an empty variable that has one', () => {
        const env = loadEnv({ ...valid, PORT: '', LOG_LEVEL: '', NODE_ENV: '' });

        expect(env.PORT).toBe(3000);
        expect(env.LOG_LEVEL).toBe('info');
        expect(env.NODE_ENV).toBe('development');
    });

    it('still rejects an empty REQUIRED variable', () => {
        // Absent and empty are the same thing, and both are still fatal here.
        expect(() => loadEnv({ ...valid, DATABASE_URL: '' })).toThrow(ConfigError);
    });

    it('does not let an empty PUBLIC_URL trip the production https rule', () => {
        const env = loadEnv({ ...validProduction, PUBLIC_URL: '' });

        expect(env.PUBLIC_URL).toBeUndefined();
    });
});
