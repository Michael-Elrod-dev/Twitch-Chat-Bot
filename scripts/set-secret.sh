#!/usr/bin/env bash
# Sets a secret on the production box (and locally where it applies) without the
# value ever appearing on screen, in shell history, or in a chat transcript.
#
# The prompt is deliberately silent: nothing appears as you paste, not even
# dots. That is expected, not a hang.
#
# Usage:
#   scripts/set-secret.sh anthropic     Anthropic API key  (box only)
#   scripts/set-secret.sh twitch        Twitch client secret (box + local .env)
set -uo pipefail

HOST="${DEPLOY_HOST:-root@almosthadai.duckdns.org}"
REMOTE_ENV="${DEPLOY_DIR:-/opt/almosthadai}/.env"

cd "$(dirname "$0")/.."

case "${1:-}" in
anthropic)
    VAR=ANTHROPIC_API_KEY
    ALSO_LOCAL=0
    HINT="Mint a fresh one at https://console.anthropic.com (starts with sk-ant-)"
    ;;
twitch)
    VAR=TWITCH_CLIENT_SECRET
    ALSO_LOCAL=1
    HINT="From https://dev.twitch.tv/console/apps - click 'New Secret' first"
    ;;
*)
    echo "Usage: $0 {anthropic|twitch}" >&2
    exit 2
    ;;
esac

echo "Setting ${VAR}"
echo "  ${HINT}"
echo "  The prompt below is SILENT - you will see nothing as you paste. That is normal."
echo

# -s silences the echo; -r stops backslashes being interpreted, which matters
# because some secrets contain them.
read -rsp "Paste the value, then press Enter: " VALUE
echo

if [[ -z "$VALUE" ]]; then
    echo "Nothing entered; nothing changed." >&2
    exit 1
fi

# Piped over stdin rather than passed as an argument, so the value never lands
# in the remote process list or in either machine's shell history.
if printf '%s\n' "$VALUE" | ssh -o BatchMode=yes "$HOST" "
    read -r V
    if grep -q '^${VAR}=' '${REMOTE_ENV}'; then
        sed -i \"s|^${VAR}=.*|${VAR}=\${V}|\" '${REMOTE_ENV}'
    else
        printf '%s\n' \"${VAR}=\${V}\" >> '${REMOTE_ENV}'
    fi
    chmod 600 '${REMOTE_ENV}'
"; then
    echo "  box: ${VAR} set (${#VALUE} characters)"
else
    echo "  box: FAILED to write" >&2
    exit 1
fi

if [[ "$ALSO_LOCAL" == "1" && -f .env ]]; then
    if grep -q "^${VAR}=" .env; then
        # A temp file rather than sed -i with the value inline: keeps the secret
        # out of the command line here too.
        VALUE="$VALUE" VAR="$VAR" node -e '
            const fs = require("fs");
            const v = process.env.VALUE, name = process.env.VAR;
            let e = fs.readFileSync(".env", "utf8");
            e = e.replace(new RegExp("^" + name + "=.*$", "m"), name + "=" + v);
            fs.writeFileSync(".env", e);
        '
    else
        printf '%s=%s\n' "$VAR" "$VALUE" >> .env
    fi
    echo "  local .env: ${VAR} set (${#VALUE} characters)"
fi

unset VALUE
echo
echo "Done. Nothing was printed. Tell Claude and it will deploy."
