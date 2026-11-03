#!/usr/bin/env bash
# Start every Tab402 service. Ctrl-C stops them all.
#   web :3000 · api :4000 · mcp-buyer :4100 · demo-sellers :4200 · worker
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env yet. Run ./demo/setup.sh first." >&2; exit 1; }
[ -d apps/web/.next ] || { echo "The web app isn't built. Run ./demo/setup.sh first." >&2; exit 1; }

for port in 3000 4000 4100 4200; do
  if lsof -iTCP:$port -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop whatever is on it (lsof -iTCP:$port -sTCP:LISTEN) and retry." >&2
    exit 1
  fi
done

pnpm db:up >/dev/null
unset NODE_ENV
trap 'kill 0' EXIT INT TERM
pnpm turbo run dev --filter='!@tab402/web' &
pnpm --filter @tab402/web start &

for _ in $(seq 1 60); do
  if curl -fs localhost:4100/health >/dev/null && curl -fs localhost:4200/health >/dev/null &&
    curl -fs -o /dev/null localhost:3000; then
    printf '\n\033[1mTab402 is up: http://localhost:3000\033[0m  (judge guide: demo/README.md)\n\n'
    break
  fi
  sleep 1
done
wait
