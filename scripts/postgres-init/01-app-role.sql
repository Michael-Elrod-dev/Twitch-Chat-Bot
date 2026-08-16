-- Design §4.1 guardrail 3: the application connects as a least-privilege role,
-- never as superuser. The bootstrap POSTGRES_USER owns the database and every
-- table in it; the app role can read and write data and nothing else.
--
-- The split matters because ALTER TABLE requires table *ownership*, not merely
-- CREATE on the schema. A runtime role that could migrate could also drop, so
-- migrations run on separate credentials (MIGRATION_DATABASE_URL) that are
-- opened at boot and closed again — see server/src/index.ts.
--
-- If the runtime credential leaks, the blast radius is the data it was always
-- able to read, not the schema and not the roles.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'almosthadai_app') THEN
        CREATE ROLE almosthadai_app LOGIN PASSWORD 'devpassword';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE almosthadai TO almosthadai_app;

-- USAGE only. Deliberately not CREATE: the runtime role has no business making
-- tables, and removing it is what makes "migrations use the other role" a rule
-- the database enforces rather than a convention we remember.
GRANT USAGE ON SCHEMA public TO almosthadai_app;

-- Applies to tables the owner creates from now on, which is every table, since
-- migrations run as the owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO almosthadai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO almosthadai_app;

-- Covers anything that already exists, so re-running this against a populated
-- database is a no-op rather than a half-privileged role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO almosthadai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO almosthadai_app;
