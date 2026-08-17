#!/usr/bin/env bash
# pg_dump -> verify -> S3, carrying Phase 0's verification discipline forward.
#
# Design §4.1 guardrail 4: the backup artifact IS the migration and resurrection
# vehicle, so an unverified dump is worse than no dump - it looks like safety.
# Nothing is uploaded, and nothing is rotated, unless the dump verifies.
#
# RETENTION IS TIERED, and the reason is a real incident rather than a policy
# preference. A flat 24-hourly window meant that a channel's data deleted more
# than a day earlier had no recoverable state anywhere: every dump in the bucket
# was already post-deletion. Hourly backups answer "undo the last hour"; they
# cannot answer "the numbers looked wrong on Tuesday", which for a product whose
# value is multi-year history is the question that actually gets asked.
#
#   hourly    newest MAX_BACKUPS (default 10)   the recent-mistake window
#   daily     newest DAILY_KEEP (default 90)    the noticed-it-later window
#   monthly   never rotated                     the year-scale record
#
# Promotion, not a second dump: the same verified artifact is copied server-side
# into the daily and monthly prefixes, so a tier can never hold a dump that was
# not verified, and the extra tiers cost one S3 copy rather than one more
# pg_dump against a live database.
#
# Env:
#   DATABASE_URL   required   postgres connection string
#   S3_BUCKET      optional   omit to verify locally without uploading
#   S3_PREFIX      optional   default database-backups/
#   BACKUP_DIR     optional   default ./backups
#   MAX_BACKUPS    optional   default 10   hourly tier
#   DAILY_KEEP     optional   default 90   daily tier
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
S3_PREFIX="${S3_PREFIX:-database-backups/}"
MAX_BACKUPS="${MAX_BACKUPS:-10}"
DAILY_KEEP="${DAILY_KEEP:-90}"
MIN_BYTES="${MIN_BYTES:-1024}"

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DAY="$(date -u +%Y-%m-%d)"
MONTH="$(date -u +%Y-%m)"
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

# ---- tier promotion --------------------------------------------------------
#
# Copied server-side from the object just uploaded, so every tier holds an
# artifact that passed the same verification. `aws s3 cp` between two keys never
# re-uploads the bytes.
#
# Idempotent by construction: the first run of a day claims that day, the rest
# find it already there and do nothing. That matters because the timer is
# `Persistent=true` — a box that was off catches up, and a catch-up run must not
# make a second copy of a day it already has.

# Only real dumps, never the `PRE daily/` lines a prefix listing also returns.
list_tier() {
    aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}$1" \
        | awk '{print $4}' \
        | grep -E '^backup-.*\.dump$' \
        || true
}

promote() {
    local tier="$1" key="$2" label="$3"
    if list_tier "$tier" | grep -q "^${key}$"; then
        echo "  ${label} already kept (${key})"
        return
    fi
    echo "  keeping ${label}: ${key}"
    aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}${FILENAME}" "s3://${S3_BUCKET}/${S3_PREFIX}${tier}${key}"
}

echo "Promoting to the daily and monthly tiers..."
promote 'daily/' "backup-${DAY}.dump" 'daily'
promote 'monthly/' "backup-${MONTH}.dump" 'monthly'

# ---- rotation --------------------------------------------------------------
#
# Rotation happens only after a verified upload, so a run of bad dumps can never
# age out the last good backup - the Phase-0 P1-10 lesson.
#
# The monthly tier is deliberately absent from this section. It is the only
# record that survives a mistake nobody noticed for a season, and a "keeping
# newest N" line is exactly how such a record quietly stops existing.

rotate() {
    local tier="$1" keep="$2" label="$3"
    echo "Rotating ${label} (keeping newest ${keep})..."
    list_tier "$tier" \
        | sort -r \
        | tail -n "+$((keep + 1))" \
        | while read -r old; do
            [[ -n "$old" ]] || continue
            echo "  removing ${old}"
            aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}${tier}${old}"
        done
}

rotate '' "$MAX_BACKUPS" 'hourly'
rotate 'daily/' "$DAILY_KEEP" 'daily'

echo "Backup complete."
