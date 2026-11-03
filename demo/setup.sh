#!/usr/bin/env bash
# One-time setup for running Tab402 locally. Safe to re-run.
#   ./demo/setup.sh
# Needs: Node 24.21.x, pnpm 12.9.x (corepack), Docker. PayPal sandbox app credentials (free at
# developer.paypal.com) are asked for once and written to .env. An Anthropic key is optional.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 Checking tools"
command -v node >/dev/null || fail "Node is not installed. Install Node 24.21.0 (e.g. nvm install 24.21.0)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a===24&&b>=21?0:1)' ||
  fail "Node $(node -v) found; Tab402 needs 24.21.x. Run: nvm install 24.21.0 && nvm use 24.21.0"
command -v pnpm >/dev/null || { corepack enable && corepack prepare pnpm@12.9.1 --activate; }
command -v docker >/dev/null || fail "Docker is not installed (Docker Desktop or OrbStack)."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start it and re-run."
echo "node $(node -v) · pnpm $(pnpm -v) · docker ok"

say "2/6 Creating .env"
rand() { node -e "console.log(require('crypto').randomBytes(32).toString('$1'))"; }
set_env() { # set_env KEY VALUE: fill KEY only when it is empty in .env
  local key=$1 value=$2
  if grep -q "^${key}=$" .env; then
    node -e 'const fs=require("fs");const [k,v]=process.argv.slice(1);fs.writeFileSync(".env",fs.readFileSync(".env","utf8").replace(new RegExp(`^${k}=$`,"m"),`${k}=${v}`))' "$key" "$value"
  elif ! grep -q "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}
[ -f .env ] || cp .env.example .env
set_env TAB402_MASTER_KEY "$(rand base64)"
set_env BETTER_AUTH_SECRET "$(rand base64url)"
set_env DEMO_SELLER_API_KEY "t402_sk_$(rand base64url)"
set_env DEMO_BUYER_API_KEY "t402_bk_$(rand base64url)"

if grep -q '^PAYPAL_CLIENT_ID=$' .env; then
  echo "PayPal sandbox credentials: developer.paypal.com → Apps & Credentials → Sandbox → your app."
  read -r -p "  PAYPAL_CLIENT_ID: " pp_id
  read -r -s -p "  PAYPAL_CLIENT_SECRET (hidden): " pp_secret; echo
  [ -n "$pp_id" ] && [ -n "$pp_secret" ] || fail "Both PayPal values are needed (the worker settles tabs through PayPal)."
  set_env PAYPAL_CLIENT_ID "$pp_id"
  set_env PAYPAL_CLIENT_SECRET "$pp_secret"
fi
if grep -q '^ANTHROPIC_API_KEY=$' .env; then
  read -r -s -p "  ANTHROPIC_API_KEY (optional, Enter to skip; hidden): " ak; echo
  if [ -n "$ak" ]; then set_env ANTHROPIC_API_KEY "$ak"; else
    echo "  Skipped: the spend guard, pricing agent and demo LLM use labelled stand-ins."
  fi
fi
echo ".env ready (secrets are not printed)"

say "3/6 Installing packages"
pnpm install --frozen-lockfile

if grep -q '^VAPID_PUBLIC_KEY=$' .env; then
  keys=$(pnpm exec tsx scripts/vapid.ts)
  set_env VAPID_PUBLIC_KEY "$(sed -n 's/^VAPID_PUBLIC_KEY=//p' <<<"$keys")"
  set_env VAPID_PRIVATE_KEY "$(sed -n 's/^VAPID_PRIVATE_KEY=//p' <<<"$keys")"
fi

say "4/6 Starting Postgres (Docker, port 5433)"
pnpm db:up

say "5/6 Migrating and seeding"
pnpm db:migrate
pnpm db:seed

say "6/6 Building the web app"
env -u NODE_ENV pnpm --filter @tab402/web build

say "Done. Start everything with: ./demo/start.sh"
