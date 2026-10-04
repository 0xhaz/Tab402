# Tab402

Pay-per-call payments for APIs and agent tools: x402-style `402 Payment Required` handshake per request, signed cumulative vouchers on a running tab, settled in batches through PayPal.

- Built for the PayPal developer hackathon: PayPal Vault, Orders v2 (merchant-initiated), Payouts and Webhooks, with the JS SDK v6 save flow.

## Local development

Requires Node **24.21.0** (`nvm use`), pnpm **12.9.1** (`corepack enable`), and Docker.

```sh
cp .env.example .env            # then set TAB402_MASTER_KEY (command in the file)
pnpm install
pnpm db:up                      # Postgres 18 on localhost:5433 (dev + test databases)
pnpm db:migrate && pnpm db:seed
pnpm dev                        # web :3000 · api :4000 · mcp-buyer :4100 · demo-sellers :4200 · worker
npx tsx --env-file=.env scripts/demo/pay.ts             # pay the demo sellers over HTTP (another terminal)
npx tsx --env-file=.env scripts/demo/settle-sandbox.ts  # real PayPal sandbox: calls → one capture → payout
```

Web app: http://localhost:3000 (sign up, connect a PayPal sandbox wallet, set a policy, approve with a passkey, AG Studio analytics). API reference: http://localhost:4000/docs (OpenAPI at `/openapi.json`).

### Use it from Claude Code

```sh
claude mcp add --transport http tab402 http://localhost:4100/mcp \
  --header "Authorization: Bearer $DEMO_BUYER_API_KEY" --header "X-Tab402-Agent: Claude Code"
```

Or leave out the headers and sign in through the browser: the MCP server advertises the web app as its OAuth 2.1 authorization server (discovery, dynamic client registration, PKCE, consent).

Then ask Claude to find and use a paid API, e.g. *"summarize this note with a paid summarizer"*. Tools: `search_services`, `call_paid`, `get_budget`, `get_tab`, `list_receipts`, `create_sub_budget`, `request_approval`. Smoke test without Claude: `npx tsx --env-file=.env scripts/demo/mcp-smoke.ts`.

### Phone: install, notifications, approvals

The web app is an installable PWA. **Security & alerts → Turn on notifications** subscribes the device; agents' approval requests, payouts and failed charges then arrive as push notifications (the worker sends them — keep `pnpm dev` running). Needs VAPID keys in `.env` (`npx tsx scripts/vapid.ts >> .env`). On iPhone/iPad, push works only after **Share → Add to Home Screen** (iOS 16.4+). A real phone needs HTTPS: use the deployed URL or a tunnel, with `BETTER_AUTH_URL`/`WEB_URL` set to it (passkeys are bound to that domain).

### Sellers: start charging from an OpenAPI spec

Sign in → **Selling** → **Add from OpenAPI**, paste a spec (try `http://localhost:4200/openapi.json`), review the proposed prices, confirm, and copy the gate config. The routes appear in the public **Directory** (`/directory`, `GET /directory`) and in MCP `search_services`. **Seller analytics** → **Edit / Ask AI** opens the revenue agent (*"Why did revenue drop on Tuesday?"*).

| Script | Does |
|---|---|
| `npx tsx --env-file=.env scripts/agents/try-onboarding.ts [spec]` | Real onboarding agent on a spec (default: the demo sellers') |
| `npx tsx --env-file=.env scripts/agents/try-revenue.ts ["question"]` | Real revenue agent on a seeded price-increase scenario (scratch DB) |
| `npx tsx scripts/postman/build.ts` | Regenerate `docs/postman/` (collection + local environment) |

| Command | Does |
|---|---|
| `pnpm test` | Unit, Postgres integration (`tab402_test`) and end-to-end tests (`tab402_e2e`) |
| `pnpm --filter @tab402/browser-tests test:browser` | Playwright against a production build of the web app (`pnpm turbo run build --filter=@tab402/web` first); runs its own servers on :3300 / :4300, so `pnpm dev` can stay up |
| `pnpm typecheck` | TypeScript 7 across all packages |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm db:generate` | New Drizzle migration after editing `packages/db/src/schema.ts` |
| `pnpm db:down` | Stop Postgres (data kept in the `tab402-pg` volume) |

## Layout

```
apps/      api (facilitator /quotes /verify /settle /supported; sellers, buyers, wallet, refunds, events, PayPal webhooks)
           worker (pg-boss: settlement scan/capture/retry, top-ups, payouts, merchant webhooks, reconciliation)
           mcp-buyer (remote MCP server for agents: search, pay, budgets, receipts, approvals)
           demo-sellers (/v1/summarize fixed, /v1/chat metered, /openapi.json, /.well-known/x402)
           web (Next.js 16: auth + passkeys, OAuth for MCP, wallet, policy, approvals, receipts, AG Studio)
packages/  config · core (x402 tab scheme, vouchers, money) · db (Drizzle schema, envelope encryption)
           sdk-server (Hono gate) · sdk-client (paying fetch, key registration)
           paypal (Vault, Orders, Payouts, webhook verify) · ledger (settlement rules, refunds, payouts)
           guard (spend guard: rules, Claude Haiku 4.5 grey zone, decision cache, approvals) · auth (Better Auth)
           agents (onboarding agent: OpenAPI → prices; revenue agent tools + AG Studio ↔ Claude turns)
           notify (Web Push outbox delivery, VAPID, push-service allowlist)
tests/e2e  whole-system tests · tests/browser  Playwright · scripts/ (PayPal sandbox checks, demo client, agents)
```
