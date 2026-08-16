import { describe, it, expect } from 'vitest';
import { loadEnv, isProduction, ConfigError } from './env.js';

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
            const env = loadEnv({ ...valid, NODE_ENV: nodeEnv, PUBLIC_URL: 'https://bot.example.com' });
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
            loadEnv({ ...valid, NODE_ENV: 'production', PUBLIC_URL: 'http://bot.example.com' })
        ).toThrow(/https/);
    });

    it('accepts an https PUBLIC_URL in production', () => {
        const env = loadEnv({ ...valid, NODE_ENV: 'production', PUBLIC_URL: 'https://bot.example.com' });

        expect(env.PUBLIC_URL).toBe('https://bot.example.com');
    });

    it('allows a plaintext PUBLIC_URL outside production', () => {
        const env = loadEnv({ ...valid, NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:3000' });

        expect(env.PUBLIC_URL).toBe('http://localhost:3000');
    });
});

describe('isProduction', () => {
    it('is true only for production', () => {
        expect(isProduction(loadEnv({ ...valid, NODE_ENV: 'production' }))).toBe(true);
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
        const env = loadEnv({ ...valid, NODE_ENV: 'production', PUBLIC_URL: '' });

        expect(env.PUBLIC_URL).toBeUndefined();
    });
});
