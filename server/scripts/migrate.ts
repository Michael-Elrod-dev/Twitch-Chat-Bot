/** Standalone migration runner for CI and ops. The server also migrates at boot. */
import { loadDatabaseEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

const env = loadDatabaseEnv();
const handle = createDb(env);

try {
    await runMigrations(handle);
    console.log('Migrations applied.');
} finally {
    await handle.close();
}
