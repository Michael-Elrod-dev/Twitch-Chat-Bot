import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DbHandle } from './client.js';

/**
 * Design §4.1 guardrail 2: schema exists solely as versioned migrations. There is
 * no other path by which a table comes into being - not a seed script, not a
 * hand-run DDL statement.
 */

/**
 * Arbitrary but fixed. Every process that migrates this database must use the
 * same number, so it lives here and nowhere else.
 */
const MIGRATION_LOCK_KEY = 8_150_204_100_251;

export async function runMigrations(handle: DbHandle): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/db -> dist -> server
    const migrationsFolder = join(here, '..', '..', 'drizzle');

    /*
     * Serialized across processes, not merely within one.
     *
     * Drizzle's migrator reads the applied-migrations table and then runs the
     * DDL, which is a check-then-act with no lock of its own. Two processes
     * migrating the same *fresh* database therefore both see nothing applied and
     * both issue CREATE TABLE - the loser fails on a duplicate pg_type entry.
     * It only bites on a cold database, because once the migration is recorded
     * neither process does anything, which is what makes it look like a
     * readiness problem rather than a race.
     *
     * Two server replicas booting together hit exactly the same window, so this
     * belongs in the migration itself and not in the test harness.
     */
    const connection = await handle.sql.reserve();

    try {
        // Session-scoped, so it must be taken and released on one connection -
        // hence the reservation. Blocks until the other process finishes.
        await connection`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

        try {
            await migrate(handle.db, { migrationsFolder });
        } finally {
            await connection`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
        }
    } finally {
        // Returns the connection to the pool even if the unlock itself failed;
        // Postgres drops session locks when the connection goes anyway.
        connection.release();
    }
}
