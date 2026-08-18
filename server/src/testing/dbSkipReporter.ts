import type { Reporter, TestModule } from 'vitest/node';

/**
 * Makes database-gated skips impossible to miss, and impossible in CI.
 *
 * The database-backed suites self-skip without `TEST_DATABASE_URL` so a
 * contributor without Docker can still run the suite. The cost is that
 * `vitest run` prints a confident green while a large share of the tests never
 * ran, which can turn a reintroduction proof into no proof at all. A defect can
 * be reintroduced, the suite report a small green number, and the tests that
 * would have caught it have silently skipped.
 *
 * The reintroduction protocol is this project's proof standard, and a protocol
 * whose evidence can quietly evaporate is not a protocol. So:
 *
 *  - Locally, a missing `TEST_DATABASE_URL` prints a banner naming the exact
 *    number of tests that did not run, and how to run them.
 *  - In CI, `REQUIRE_DB_TESTS=1` turns any skip into a failure, so the gap can
 *    never migrate from a laptop into the pipeline.
 */

const ESC = String.fromCharCode(27);
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

const NL = '\n';

export default class DbSkipReporter implements Reporter {
    onTestRunEnd(testModules: readonly TestModule[] = []): void {
        let skipped = 0;
        for (const mod of testModules) {
            for (const test of mod.children.allTests()) {
                if (test.result().state === 'skipped') skipped++;
            }
        }

        if (skipped === 0) return;

        if (process.env['REQUIRE_DB_TESTS'] === '1') {
            /*
             * CI. A skip here means the Postgres service did not come up, or
             * the variable was not passed through - either way the suite did
             * not test what a green check would claim it tested.
             */
            process.stderr.write([
                '',
                `${RED}${BOLD}  REQUIRE_DB_TESTS=1 but ${skipped} test(s) were skipped.${RESET}`,
                `${RED}  The database-backed suites did not run. That is a failure, not a pass.${RESET}`,
                '',
                ''
            ].join(NL));

            process.exitCode = 1;
            return;
        }

        if (!process.env['TEST_DATABASE_URL']) {
            process.stderr.write([
                '',
                `${YELLOW}${BOLD}  ${skipped} test(s) SKIPPED - no TEST_DATABASE_URL.${RESET}`,
                `${YELLOW}  The database-backed suites did not run. A green result here does NOT${RESET}`,
                `${YELLOW}  mean the change is covered - reintroduction proofs run against them.${RESET}`,
                `${YELLOW}  Run them with:${RESET}`,
                `${YELLOW}    eval "$(bash scripts/test-db.sh start)" && npm run test:server${RESET}`,
                '',
                ''
            ].join(NL));
        }
    }
}
