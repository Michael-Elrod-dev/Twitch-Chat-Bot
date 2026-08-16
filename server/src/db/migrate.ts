import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DbHandle } from './client.js';

/**
 * Design §4.1 guardrail 2: schema exists solely as versioned migrations. There is
 * no other path by which a table comes into being - not a seed script, not a
 * hand-run DDL statement.
 */
export async function runMigrations(handle: DbHandle): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/db -> dist -> server
    const migrationsFolder = join(here, '..', '..', 'drizzle');

    await migrate(handle.db, { migrationsFolder });
}
