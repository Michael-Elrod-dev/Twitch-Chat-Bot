#!/usr/bin/env bash
# Deploys the server to the VPS from this machine.
#
# An interim mechanism. This rsyncs a working copy and builds on the box, which
# is fast to write and fine for one server, but not how this should work
# long-term. The successor is a registry push from CI on a version tag, with the
# box pulling a known-good image, and it is on the ops backlog. Until then, what
# you deploy is what is on your disk, so deploy from a clean tree.
#
# What is deliberately not sent:
#   .env              production secrets live on the box and only on the box
#   compose.override  the dev overlay would bind-mount source over the image
#   node_modules      built inside the image, for the image's platform
#
# Usage:
#   scripts/deploy.sh                 build and restart
#   scripts/deploy.sh --no-build      push files and restart only
#   scripts/deploy.sh --dry-run       show what would transfer
set -euo pipefail

HOST="${DEPLOY_HOST:-root@almosthadai.duckdns.org}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/almosthadai}"

BUILD=1
RSYNC_EXTRA=()
for arg in "$@"; do
    case "$arg" in
    --no-build) BUILD=0 ;;
    --dry-run)  RSYNC_EXTRA+=(--dry-run --itemize-changes) ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."

if [[ ! -f docker-compose.yml ]]; then
    echo "Not at the repository root; aborting." >&2
    exit 1
fi

echo "==> Deploying to ${HOST}:${REMOTE_DIR}"

# A dirty tree is not a blocker, but you should know before you ship it.
if command -v git >/dev/null && ! git diff --quiet HEAD 2>/dev/null; then
    echo "    NOTE: working tree has uncommitted changes - they will be deployed"
fi

ssh -o BatchMode=yes "$HOST" "mkdir -p '${REMOTE_DIR}'"

# Two lists, because the distinction is load-bearing.
#
# ANYWHERE matches at any depth, because a node_modules or dist is unwanted
# wherever it appears. ROOT_ONLY must be anchored, because a bare name matches
# nested directories too, and a pattern meant for one root-level path can
# silently exclude `shared/src` or `server/src`, which are the entire thing
# being deployed. Both rsync and tar match unanchored patterns at every level.
EXCLUDE_ANYWHERE=(
    '.git' '.github' 'node_modules' 'dist' '*.tsbuildinfo'
    'coverage' 'logs' 'temp_backups' '.claude' '.idea'
)
# Anchored to the transfer root: root-level names, plus specific nested paths
# that must not be matched by name alone.
#
# The Rust build output is the reason this list now has paths in it. It is 2.6GB
# and ~9600 files of compiled artifacts for a WINDOWS desktop client, on the way
# to a 40GB Linux box that never builds or runs it, since the image copies only
# shared/ and server/. Excluding by the bare name `target` would be a footgun
# waiting for the first unrelated directory called that, so it is named in full.
EXCLUDE_ROOT_ONLY=(
    '.env' '.env.*' 'compose.override.yml'
    'app/src-tauri/target' 'app/src-tauri/gen'
)

if command -v rsync >/dev/null 2>&1; then
    RSYNC_EXCLUDES=()
    for e in "${EXCLUDE_ANYWHERE[@]}"; do RSYNC_EXCLUDES+=(--exclude "$e"); done
    # A leading slash anchors to the transfer root in rsync.
    for e in "${EXCLUDE_ROOT_ONLY[@]}"; do RSYNC_EXCLUDES+=(--exclude "/$e"); done

    # --delete keeps the box a mirror rather than an accumulation of every file
    # that has ever been deployed.
    rsync -az --delete "${RSYNC_EXTRA[@]}" "${RSYNC_EXCLUDES[@]}" \
        -e "ssh -o BatchMode=yes" \
        ./ "${HOST}:${REMOTE_DIR}/"

    if [[ " ${RSYNC_EXTRA[*]} " == *"--dry-run"* ]]; then
        echo "==> Dry run complete; nothing was changed on the box."
        exit 0
    fi
else
    # Git Bash on Windows has no rsync, and requiring one would make the deploy
    # path depend on the operator's shell. tar over ssh is everywhere.
    echo "    (rsync unavailable - using tar over ssh)"

    TAR_EXCLUDES=()
    for e in "${EXCLUDE_ANYWHERE[@]}"; do TAR_EXCLUDES+=(--exclude="$e"); done
    # `./name` anchors to the archive root in tar, the same way a leading slash
    # does for rsync.
    for e in "${EXCLUDE_ROOT_ONLY[@]}"; do TAR_EXCLUDES+=(--exclude="./$e"); done

    if [[ " ${RSYNC_EXTRA[*]} " == *"--dry-run"* ]]; then
        tar czf - "${TAR_EXCLUDES[@]}" . | tar tzf - | head -60
        echo "==> Dry run complete; nothing was changed on the box."
        exit 0
    fi

    # tar cannot delete what it does not carry, so stale files are cleared
    # first. .env is preserved explicitly - it is the one thing on the box that
    # exists nowhere else.
    ssh -o BatchMode=yes "$HOST" "cd '${REMOTE_DIR}' && find . -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +"
    tar czf - "${TAR_EXCLUDES[@]}" . | ssh -o BatchMode=yes "$HOST" "tar xzf - -C '${REMOTE_DIR}'"
fi

echo "==> Files synced"

ssh -o BatchMode=yes "$HOST" bash -s <<REMOTE
set -euo pipefail
cd '${REMOTE_DIR}'

if [[ ! -f .env ]]; then
    echo "No .env on the box. Production secrets are created there and only there." >&2
    exit 1
fi

# -f docker-compose.yml explicitly: even though compose.override.yml is never
# synced, naming the file means a stray copy could not silently apply the dev
# overlay to production.
if [[ "${BUILD}" == "1" ]]; then
    echo "==> Building image on the box"
    docker compose -f docker-compose.yml build
fi

echo "==> Starting"
docker compose -f docker-compose.yml up -d --remove-orphans

# Asked from inside the container network. The server's port is deliberately
# not published on the host in production - only Caddy is exposed - so there is
# no 127.0.0.1:3000 to curl.
echo "==> Waiting for readiness"
probe='fetch("http://127.0.0.1:3000/readyz").then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'
for i in \$(seq 1 30); do
    if out=\$(docker compose -f docker-compose.yml exec -T server node -e "\$probe" 2>/dev/null); then
        echo "==> Ready: \$out"
        exit 0
    fi
    sleep 2
done

echo "Server did not become ready. Recent logs:" >&2
docker compose -f docker-compose.yml logs --tail 40 server >&2
exit 1
REMOTE

echo "==> Deploy complete"
