import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],

        /*
         * `default` keeps the normal output; the second makes DB-gated skips
         * loud locally and fatal in CI. See dbSkipReporter for why a silently
         * green suite is a real hazard rather than a cosmetic one.
         */
        reporters: ['default', './src/testing/dbSkipReporter.ts'],

        /*
         * Test FILES run one at a time.
         *
         * The database-backed suites share one Postgres, and some of the schema
         * is genuinely global rather than channel-scoped — `bot_identity` holds
         * exactly one row by design, and `viewers` is a shared identity table.
         * Two files mutating those in parallel workers fail against each other
         * in ways that look like real defects and move around between runs.
         *
         * Channel-scoped suites are already isolated by construction (every
         * fixture makes its own channel), so this costs a few seconds and buys
         * determinism for the handful of tables that cannot be.
         */
        fileParallelism: false,

        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/index.ts']
        }
    }
});
