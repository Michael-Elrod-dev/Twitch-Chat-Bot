#!/usr/bin/env bash
# Throwaway Postgres for the test suites.
#
# The suites delete rows, truncate globally-scoped tables, and assume they own
# the schema. They must therefore never run against the development compose
# database, which holds the owner's imported production data and live Twitch
# credentials — pointing them at it once already destroyed that import.
#
# This container is deliberately separate in every way that matters: its own
# name, its own port, its own volume-less lifetime. `-v` against the dev compose
# project is never the answer, because this exists instead.
#
# Usage:
#   eval "$(scripts/test-db.sh start)"   # exports TEST_DATABASE_URL
#   npm run test:server
#   scripts/test-db.sh stop
set -euo pipefail

CONTAINER="almosthadai-test-db"
PORT="${TEST_DB_PORT:-55432}"
URL="postgres://test:test@127.0.0.1:${PORT}/test"

case "${1:-start}" in
start)
    if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
        # --rm and no volume: nothing here outlives the container, by design.
        docker run -d --rm --name "$CONTAINER" \
            -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
            -p "127.0.0.1:${PORT}:5432" \
            postgres:17 >/dev/null

        # The suites also wait for readiness themselves (bounded retry), so this
        # only needs to get the container accepting connections.
        for _ in $(seq 1 30); do
            if docker exec "$CONTAINER" pg_isready -U test -d test >/dev/null 2>&1; then break; fi
            sleep 1
        done
    fi
    echo "export TEST_DATABASE_URL='${URL}'"
    ;;

stop)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "Removed ${CONTAINER}" >&2
    ;;

url)
    echo "$URL"
    ;;

*)
    echo "Usage: $0 {start|stop|url}" >&2
    exit 1
    ;;
esac
