import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';

/**
 * Test-suite bootstrap for the database-backed suites.
 *
 * A container that is *starting* is not a container that is *ready*: Postgres
 * accepts a TCP connection while it is still replaying WAL and initialising, so
 * a cold `docker compose up` followed immediately by the suite produces a
 * connection error that looks exactly like a broken test. Bounded retry turns
 * that race into a few seconds of waiting.
 */

export interface WaitOptions {
    attempts?: number;
    delayMs?: number;
}

const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 1_000;

/** @throws the last connection error once the attempts are exhausted — bounded, never a hang. */
export async function waitForDatabase(handle: DbHandle, options: WaitOptions = {}): Promise<void> {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await handle.ping();
            return;
        } catch (err) {
            lastError = err;
            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }

    throw new Error(
        `Postgres was not ready after ${attempts} attempts (${(attempts * delayMs) / 1000}s): ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
}

/**
 * Opens a connection, waits for readiness, and migrates — the three steps every
 * database suite needs before it can assert anything.
 */
export async function connectTestDatabase(url: string, options: WaitOptions = {}): Promise<DbHandle> {
    const handle = createDb({ DATABASE_URL: url, DATABASE_POOL_MAX: 4 });
    await waitForDatabase(handle, options);
    await runMigrations(handle);
    return handle;
}
