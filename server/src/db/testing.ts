import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';

/**
 * Test-suite bootstrap for the database-backed suites.
 *
 * A container that is *starting* is not a container that is *ready*: Postgres
 * accepts a TCP connection while it is still replaying WAL and initializing, so
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

/** @throws the last connection error once the attempts are exhausted. Bounded, never a hang. */
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
 * Databases the test suites must never open.
 *
 * This is enforcement, not documentation. The development compose database
 * holds the owner's imported production data and their live Twitch credentials;
 * the suites delete rows, truncate `bot_identity`, and generally assume they own
 * the schema. Pointing them at that database once already destroyed the
 * production import once already, so "remember not to" is not a control.
 *
 * Tests get their own throwaway container, started by `scripts/test-db.sh`.
 */
const FORBIDDEN_DATABASE_NAMES = ['almosthadai'];

export class UnsafeTestDatabaseError extends Error {
    constructor(name: string) {
        super(
            `Refusing to run tests against the "${name}" database: it is the development database, ` +
            'which holds real credentials and imported production data. ' +
            'Start a throwaway one with scripts/test-db.sh and point TEST_DATABASE_URL at it.'
        );
        this.name = 'UnsafeTestDatabaseError';
    }
}

/** @throws {UnsafeTestDatabaseError} when the URL names a protected database. */
export function assertSafeTestDatabase(url: string): void {
    let name: string;
    try {
        // Leading slash stripped; a URL with no path yields '', which is not forbidden.
        name = new URL(url).pathname.replace(/^\//, '');
    } catch {
        // An unparseable URL will fail at connect time with a better message.
        return;
    }

    if (FORBIDDEN_DATABASE_NAMES.includes(name)) {
        throw new UnsafeTestDatabaseError(name);
    }
}

/**
 * Opens a connection, waits for readiness, and migrates. Those are the three
 * steps every database suite needs before it can assert anything.
 */
export async function connectTestDatabase(url: string, options: WaitOptions = {}): Promise<DbHandle> {
    assertSafeTestDatabase(url);

    const handle = createDb({ DATABASE_URL: url, DATABASE_POOL_MAX: 4 });
    await waitForDatabase(handle, options);
    await runMigrations(handle);
    return handle;
}
