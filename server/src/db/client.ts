import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';
import type { DatabaseEnv } from '../config/env.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
    db: Database;
    sql: postgres.Sql;
    /** Cheap liveness query for the readiness probe. */
    ping: () => Promise<void>;
    close: () => Promise<void>;
}

/**
 * Postgres connection.
 *
 * Design §4.1 guardrail 1: the app knows only DATABASE_URL. No locality
 * assumptions live here, so moving to a managed Postgres is a URL change.
 * Guardrail 6: pooling is configured here so a managed pooler slots in without
 * touching call sites.
 */
export function createDb(env: DatabaseEnv): DbHandle {
    const sql = postgres(env.DATABASE_URL, {
        max: env.DATABASE_POOL_MAX,
        idle_timeout: 30,
        connect_timeout: 10,
        // The app must never be the thing that mangles a chat message's emoji.
        transform: { undefined: null }
    });

    const db = drizzle(sql, { schema });

    return {
        db,
        sql,
        ping: async () => {
            await sql`select 1`;
        },
        close: async () => {
            await sql.end({ timeout: 5 });
        }
    };
}
