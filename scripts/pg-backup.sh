#!/usr/bin/env bash
# pg_dump -> verify -> S3, carrying Phase 0's verification discipline forward.
#
# Design §4.1 guardrail 4: the backup artifact IS the migration and resurrection
# vehicle, so an unverified dump is worse than no dump - it looks like safety.
# Nothing is uploaded, and nothing is rotated, unless the dump verifies.
#
# Env:
#   DATABASE_URL   required   postgres connection string
#   S3_BUCKET      optional   omit to verify locally without uploading
#   S3_PREFIX      optional   default database-backups/
#   BACKUP_DIR     optional   default ./backups
#   MAX_BACKUPS    optional   default 10
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
S3_PREFIX="${S3_PREFIX:-database-backups/}"
MAX_BACKUPS="${MAX_BACKUPS:-10}"
MIN_BYTES="${MIN_BYTES:-1024}"

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILENAME="backup-${TIMESTAMP}.dump"
LOCAL_PATH="${BACKUP_DIR}/${FILENAME}"

mkdir -p "$BACKUP_DIR"

cleanup_local() { rm -f "$LOCAL_PATH"; }
trap cleanup_local EXIT

echo "Dumping database..."
# Custom format (-Fc): compressed, and restorable selectively with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --file="$LOCAL_PATH" "$DATABASE_URL"

echo "Verifying dump..."

# 1. Size floor. A dump below this cannot contain a schema, let alone data.
SIZE=$(wc -c < "$LOCAL_PATH")
if [[ "$SIZE" -lt "$MIN_BYTES" ]]; then
    echo "FAILED: dump is ${SIZE} bytes, below the ${MIN_BYTES} byte floor" >&2
    exit 1
fi

# 2. Structural check. pg_restore --list parses the archive's table of contents;
#    it fails on a truncated or corrupt file. This is the custom-format
#    equivalent of Phase 0's "-- Dump completed" marker, and strictly stronger:
#    it proves the archive is readable, not merely that it ended.
if ! pg_restore --list "$LOCAL_PATH" > /dev/null 2>&1; then
    echo "FAILED: dump is not a readable pg_restore archive" >&2
    exit 1
fi

# 3. Content check. An archive that restores but contains no tables is a
#    successful backup of nothing.
TABLE_COUNT=$(pg_restore --list "$LOCAL_PATH" | grep -c 'TABLE DATA\|TABLE ' || true)
if [[ "$TABLE_COUNT" -lt 1 ]]; then
    echo "FAILED: dump contains no tables" >&2
    exit 1
fi

echo "Verified: ${SIZE} bytes, ${TABLE_COUNT} table entries"

if [[ -z "${S3_BUCKET:-}" ]]; then
    echo "S3_BUCKET not set - verified locally, not uploading."
    # Keep the artifact when we are not shipping it anywhere.
    trap - EXIT
    echo "Dump retained at ${LOCAL_PATH}"
    exit 0
fi

echo "Uploading to s3://${S3_BUCKET}/${S3_PREFIX}${FILENAME}..."
aws s3 cp "$LOCAL_PATH" "s3://${S3_BUCKET}/${S3_PREFIX}${FILENAME}"

# Rotation happens only after a verified upload, so a run of bad dumps can never
# age out the last good backup - the Phase-0 P1-10 lesson.
echo "Rotating (keeping newest ${MAX_BACKUPS})..."
aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}" \
    | awk '{print $4}' \
    | sort -r \
    | tail -n "+$((MAX_BACKUPS + 1))" \
    | while read -r old; do
        [[ -n "$old" ]] || continue
        echo "  removing ${old}"
        aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}${old}"
    done

echo "Backup complete."
