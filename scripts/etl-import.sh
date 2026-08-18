#!/usr/bin/env bash
# Imports the recovered MySQL dump into the current schema as channel #1.
#
# The dump is read via a throwaway mysql:8 container that exists only for the
# duration of this script and is removed (with its volume) afterwards, so the
# credentials inside the dump are never persisted anywhere new.
#
# Usage:  scripts/etl-import.sh [path-to-dump.sql]
set -euo pipefail

DUMP="${1:-temp_backups/recovered-backup-2026-01-30.sql}"
CONTAINER="almosthadai-etl-mysql"
MYSQL_PORT="${MYSQL_PORT:-13306}"
MYSQL_ROOT_PASSWORD="etl-throwaway-$RANDOM"

if [[ ! -f "$DUMP" ]]; then
    echo "Dump not found: $DUMP" >&2
    exit 1
fi

: "${DATABASE_URL:?DATABASE_URL must point at the target Postgres}"

cleanup() {
    echo "Removing throwaway MySQL container..."
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting throwaway MySQL..."
docker run -d --rm \
    --name "$CONTAINER" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
    -e MYSQL_DATABASE=recovered \
    -p "127.0.0.1:${MYSQL_PORT}:3306" \
    mysql:8 \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null

# A real query, not mysqladmin ping: during initialization MySQL runs a
# temporary server that answers pings before the configured root password
# exists, so ping alone reports ready too early.
echo "Waiting for MySQL to accept authenticated queries..."
ready=0
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" recovered >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done

if [[ "$ready" -ne 1 ]]; then
    echo "MySQL never became ready" >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 1
fi

echo "Loading dump..."
docker exec -i "$CONTAINER" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" recovered < "$DUMP"

echo "Running ETL..."
MYSQL_URL="mysql://root:${MYSQL_ROOT_PASSWORD}@127.0.0.1:${MYSQL_PORT}/recovered" \
DATABASE_URL="$DATABASE_URL" \
    npx tsx server/scripts/etl/import-dump.ts

echo "Done."
