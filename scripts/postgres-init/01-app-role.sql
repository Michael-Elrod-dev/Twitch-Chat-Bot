-- Design §4.1 guardrail 3: the application connects as a least-privilege role,
-- never as superuser. The bootstrap POSTGRES_USER owns the database; the app
-- role can read and write data but cannot create or drop databases or roles.
--
-- Migrations need DDL, so the app role owns the public schema - but it is still
-- not a superuser, which is the property that matters if the credential leaks.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'almosthadai_app') THEN
        CREATE ROLE almosthadai_app LOGIN PASSWORD 'devpassword';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE almosthadai TO almosthadai_app;
GRANT USAGE, CREATE ON SCHEMA public TO almosthadai_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO almosthadai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO almosthadai_app;
