#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
fi

if [[ -z "${DEEZER_ARL:-}" ]]; then
    echo "Attention : DEEZER_ARL n'est pas défini. La récupération Deezer restera désactivée." >&2
fi

if [[ ! -x "$ROOT/.venv/bin/uvicorn" ]]; then
    echo "Binaires manquants : .venv/bin/uvicorn. Lance d'abord la préparation de l'environnement Python." >&2
    exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8000}"

case "$HOST" in
    127.0.0.1 | localhost | ::1 | "[::1]") ;;
    *)
        if [[ "${ALLOW_NETWORK:-}" != "1" ]]; then
            echo "HOST=$HOST n'est pas une adresse locale. Night Light n'a aucune" >&2
            echo "authentification : ne l'expose pas. Force avec ALLOW_NETWORK=1." >&2
            exit 1
        fi
        ;;
esac

"$ROOT/.venv/bin/uvicorn" server.main:app --host "$HOST" --port "$PORT" "$@" &
UVICORN_PID=$!

kill_descendants() {
    local parent="$1"
    local pid=""
    for pid in $(pgrep -P "$parent" 2>/dev/null || true); do
        kill_descendants "$pid"
        kill -TERM "$pid" 2>/dev/null || true
    done
}

cleanup() {
    kill_descendants "$UVICORN_PID"
    kill -TERM "$UVICORN_PID" 2>/dev/null || true
    wait "$UVICORN_PID" 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM EXIT

wait "$UVICORN_PID"
STATUS=$?
trap - INT TERM EXIT
exit "$STATUS"
