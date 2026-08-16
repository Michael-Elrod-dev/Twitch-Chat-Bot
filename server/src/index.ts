import { createServer } from 'node:http';
import { loadEnv, ConfigError } from './config/env.js';
import { createLogger } from './logger.js';
import { createApp } from './http/app.js';
import { createShutdownHandler, installSignalHandlers } from './lifecycle.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const VERSION = process.env['npm_package_version'] ?? '0.1.0';

async function main(): Promise<void> {
    let env;
    try {
        env = loadEnv();
    } catch (error) {
        if (error instanceof ConfigError) {
            // Before the logger exists, so this is the one legitimate console use.
            console.error(error.message);
            process.exit(78); // EX_CONFIG
        }
        throw error;
    }

    const logger = createLogger(env);

    const database = createDb(env);

    // Migrations run at boot: the schema a deployment gets is the schema its code
    // was built against, with no separate "did you remember to migrate" step.
    try {
        await runMigrations(database);
        logger.info('Database migrations applied');
    } catch (err) {
        logger.fatal({ err }, 'Database migration failed');
        await database.close();
        process.exit(1);
    }

    const app = createApp({
        logger,
        version: VERSION,
        probes: [{ name: 'postgres', check: database.ping }]
    });
    const server = createServer(app);

    const shutdown = createShutdownHandler({
        server,
        logger,
        closeables: [{ name: 'postgres', close: database.close }]
    });
    installSignalHandlers(shutdown, logger);

    server.listen(env.PORT, () => {
        logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV, version: VERSION }, 'Server listening');
    });
}

void main();
