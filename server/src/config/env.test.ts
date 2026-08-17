import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
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
 * Production refuses the committed development signing secret and refuses to
 * run with tokens in plaintext, so every production case has to carry both a
 * real secret and an encryption key. Bundling them here keeps those rules from
 * being restated in a dozen places.
 */
const PRODUCTION_SECRET = 'a-genuine-production-eventsub-secret';
const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const validProduction = {
    ...valid,
    NODE_ENV: 'production',
    TWITCH_EVENTSUB_SECRET: PRODUCTION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY
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
    it('rejects each invalid single-variable value', () => {
        const rows: { name: string; env: Record<string, string> }[] = [
            { name: 'missing DATABASE_URL', env: { REDIS_URL: valid.REDIS_URL } },
            { name: 'missing REDIS_URL', env: { DATABASE_URL: valid.DATABASE_URL } },
            { name: 'PORT 0', env: { ...valid, PORT: '0' } },
            { name: 'PORT 70000', env: { ...valid, PORT: '70000' } },
            { name: 'non-integer PORT', env: { ...valid, PORT: '3000.5' } },
            { name: 'unknown NODE_ENV', env: { ...valid, NODE_ENV: 'staging' } },
            { name: 'malformed PUBLIC_URL', env: { ...valid, PUBLIC_URL: 'not a url' } },
            { name: 'short JWT_SECRET', env: { ...valid, JWT_SECRET: 'short' } },
            { name: 'non-ASCII signing secret', env: { ...valid, TWITCH_EVENTSUB_SECRET: 'sécret-with-accents' } }
        ];

        for (const row of rows) {
            expect(() => loadEnv(row.env), row.name).toThrow(ConfigError);
        }
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

    it('reports every production problem together', () => {
        // Three wrong should mean one restart, not three.
        try {
            loadEnv({
                ...valid,
                NODE_ENV: 'production',
                PUBLIC_URL: 'http://bot.example.com',
                TWITCH_EVENTSUB_SECRET: DEV_EVENTSUB_SECRET
            });
            expect.unreachable('should have thrown');
        } catch (error) {
            const issues = (error as ConfigError).issues;
            expect(issues.some((i) => i.startsWith('PUBLIC_URL'))).toBe(true);
            expect(issues.some((i) => i.startsWith('TWITCH_EVENTSUB_SECRET'))).toBe(true);
            expect(issues.some((i) => i.startsWith('TOKEN_ENCRYPTION_KEY'))).toBe(true);
        }
    });

    it('refuses to run production with tokens in plaintext', () => {
        // The only version of this rule that cannot be ignored.
        const withoutKey = { ...validProduction, TOKEN_ENCRYPTION_KEY: '' };

        expect(() => loadEnv(withoutKey)).toThrow(/TOKEN_ENCRYPTION_KEY/);
    });

    it('allows development to run without an encryption key', () => {
        // Development still cannot *store* a token - the cipher refuses - but it
        // can boot, which is what makes the rest of the server workable offline.
        expect(loadEnv({ ...valid }).TOKEN_ENCRYPTION_KEY).toBeUndefined();
    });
});

describe('loadEnv - token encryption key', () => {
    it('accepts a valid 32-byte key in base64 or hex', () => {
        const key = randomBytes(32);

        expect(loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: key.toString('base64') }).TOKEN_ENCRYPTION_KEY).toBeTruthy();
        expect(loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: key.toString('hex') }).TOKEN_ENCRYPTION_KEY).toBeTruthy();
    });

    it('rejects a key of the wrong size at boot, not at first use', () => {
        expect(() => loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: randomBytes(16).toString('base64') }))
            .toThrow(ConfigError);
    });

    it('never puts the key in the error message', () => {
        const key = randomBytes(8).toString('base64');
        try {
            loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: key });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as ConfigError).message).not.toContain(key);
        }
    });
});

describe('loadEnv - live EventSub mode', () => {
    const live = { ...valid, EVENTSUB_DRY_RUN: 'false' };

    it('defaults to a dry run', () => {
        // A misconfigured deployment must not be able to delete a working
        // channel's subscriptions on its first boot.
        expect(loadEnv({ ...valid }).EVENTSUB_DRY_RUN).toBe(true);
    });

    it('requires client credentials and a public URL to go live', () => {
        try {
            loadEnv(live);
            expect.unreachable('should have thrown');
        } catch (error) {
            const issues = (error as ConfigError).issues.join('\n');
            expect(issues).toContain('TWITCH_CLIENT_ID');
            expect(issues).toContain('PUBLIC_URL');
        }
    });

    it('accepts a fully configured live setup', () => {
        const env = loadEnv({
            ...live,
            TWITCH_CLIENT_ID: 'id',
            TWITCH_CLIENT_SECRET: 'secret',
            PUBLIC_URL: 'https://bot.example.com'
        });

        expect(env.EVENTSUB_DRY_RUN).toBe(false);
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

    it('does not let an empty PUBLIC_URL trip the production https rule', () => {
        const env = loadEnv({ ...validProduction, PUBLIC_URL: '' });

        expect(env.PUBLIC_URL).toBeUndefined();
    });
});
