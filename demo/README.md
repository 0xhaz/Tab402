# Tab402 demo for judges

This folder gets Tab402 running on your machine in about ten minutes and walks you through what to try. Everything runs locally against the PayPal sandbox. No real money moves.

## Contents

- [What you need](#what-you-need)
- [Set up and start](#set-up-and-start)
- [Walkthrough](#walkthrough)
  - [1. Look around signed out](#1-look-around-signed-out)
  - [2. Sign up as the demo buyer](#2-sign-up-as-the-demo-buyer)
  - [3. Let an agent pay](#3-let-an-agent-pay)
  - [4. Approve a purchase from the agent](#4-approve-a-purchase-from-the-agent)
  - [5. Budgets and the spend guard](#5-budgets-and-the-spend-guard)
  - [6. Settle the tab on PayPal](#6-settle-the-tab-on-paypal)
  - [7. The seller side](#7-the-seller-side)
  - [8. Analytics](#8-analytics)
  - [9. Optional: connect Claude Code](#9-optional-connect-claude-code)
- [What works without which key](#what-works-without-which-key)
- [Troubleshooting](#troubleshooting)
- [Reset or stop](#reset-or-stop)

## What you need

| Tool | Version | Notes |
|---|---|---|
| Node | 24.21.x | `nvm install 24.21.0 && nvm use 24.21.0` |
| pnpm | 12.9.x | `corepack enable` installs it |
| Docker | any recent | Docker Desktop or OrbStack, running. Postgres uses port 5433 |
| PayPal sandbox app | | Client ID and secret from [developer.paypal.com](https://developer.paypal.com) under Apps & Credentials, Sandbox tab. Free |
| PayPal sandbox personal account | | Only for saving a wallet in the web app (step 2). Listed under Testing Tools, Sandbox Accounts |
| Anthropic API key | optional | Without it the spend guard, pricing agent and demo LLM use labelled stand-ins |
| Browser | Chrome | Passkeys and push notifications work on `localhost` in Chrome |

Ports 3000, 4000, 4100 and 4200 must be free.

## Set up and start

```sh
git clone https://github.com/0xhaz/Tab402.git && cd Tab402
./demo/setup.sh     # checks tools, writes .env, installs, starts Postgres, migrates, seeds, builds
./demo/start.sh     # starts every service; Ctrl-C stops them
```

`setup.sh` asks for your PayPal sandbox client ID and secret, and optionally an Anthropic key. It generates every other secret itself and never prints them. You can re-run it safely; it only fills values that are empty.

When `start.sh` prints `Tab402 is up`, open http://localhost:3000.

| Service | URL |
|---|---|
| Web app | http://localhost:3000 |
| Facilitator API and its reference | http://localhost:4000/docs |
| MCP server for agents | http://localhost:4100/mcp |
| Demo seller (a paid API) | http://localhost:4200/openapi.json |

## Walkthrough

### 1. Look around signed out

Open http://localhost:3000 in a private window. The landing page has a slider that compares the card fees of charging every call with the fees on one Tab402 tab. **Directory** lists the paid APIs agents can buy, with no sign-in. You should see "Summarize text" ($0.01) and "Chat with a model" (metered) from Tab402 Demo Sellers.

### 2. Sign up as the demo buyer

Click **Get started** and sign up with the email `buyer@example.com`, any name and any password of 8 or more characters. That email claims the seeded demo buyer, which already has a $10 prepaid balance and an agent.

You land on **Overview** with the balance. Two optional extras on this account:

- **Security & alerts**: add a passkey (Touch ID) and turn on notifications. Approval requests then arrive as a push and you approve with the passkey.
- **Wallet**: save a PayPal sandbox wallet with the sandbox personal account. The PayPal popup uses the JS SDK v6 save flow and stores a Vault token.

### 3. Let an agent pay

Open **Agent playground** in the sidebar. It talks to the MCP server the same way Claude Code or any other agent would, as an agent named "Playground". It should say "Connected · 7 tools".

Click the steps in order and watch the Activity column:

1. **Check my budget** shows the $10 daily budget.
2. **Find a summarizer** searches the directory and finds `POST http://localhost:4200/v1/summarize` at $0.01. Agents call that URL; opening it in a browser gives 404 because it only takes a paid POST.
3. **Summarize the note** pays one cent and returns the summary.
4. **Chat (metered)** charges what the call actually cost, up to its $0.05 ceiling.

Keep **Receipts** open in another tab. New rows appear within a few seconds without reloading, each with what the agent said it was buying.

### 4. Approve a purchase from the agent

Back in the playground, turn on **Ask me before every purchase**. That sets the approval threshold to half a cent, so every call now needs your OK.

Click **Summarize the note** again. The card turns amber with **Open approval page**. If notifications are on, a push arrives too. Approve (with the passkey if you added one), then click **Run again after approving**. The call goes through and is charged once. Try it again and press **Decline** instead: the agent is told it was declined and nothing is charged.

Turn the switch off when you're done.

### 5. Budgets and the spend guard

- **Make a $0.02 sub-budget**, then **Summarize with the sub-budget** three times. The first two pay; the third is refused by the cap.
- **Off-purpose purchase** asks for a summary for something that doesn't match. The spend guard checks fixed rules first (budgets, allow and block lists, per-call maximum, approval threshold). Unusual cases, such as a first-time seller or a price spike, go to Claude Haiku 4.5, which approves, denies or asks you. The reason shows on **Approvals** and **Analytics**.
- **Agents & keys** lets you revoke an agent. Its next call is refused.

### 6. Settle the tab on PayPal

The worker settles on its own when a tab reaches $10 or is 24 hours old. To see it now, run these in a new terminal from the repo root. Your sandbox app needs Vault and Payouts turned on (developer.paypal.com, your app, Features).

```sh
# Save a sandbox wallet with PayPal Vault v3. Open the printed link and approve it
# while logged in as your sandbox personal account.
npx tsx --env-file=.env scripts/sandbox/2-vault-setup.ts
npx tsx --env-file=.env scripts/sandbox/3-vault-exchange.ts

# 50 paid calls, one capture for the whole tab, then a payout to the seller.
npx tsx --env-file=.env scripts/demo/settle-sandbox.ts 50 <your-sandbox-personal-email>
```

The last script captures the whole tab as one merchant-initiated PayPal order (Orders v2 with the vaulted wallet), then pays the seller with the Payouts API. Its output shows the capture with its PayPal fee and the payout batch status. In **Receipts** those calls move from *earned* to *collected* and then *paid out*.

The script switches the demo buyer to a post-paid mandate on the wallet saved here, which replaces any wallet you saved in step 2.

### 7. The seller side

Make the seeded demo seller belong to your account, so its traffic shows up:

```sh
./demo/link-seller.sh
```

Then open **Selling**:

- Tiles for earned, collected and paid out, and the demo endpoints.
- **Add from OpenAPI**: paste `http://localhost:4200/openapi.json` and click **Propose prices**. Claude Sonnet 5.5 reads the spec and proposes a price per route, leaving `/health` free. Set the base URL to something like `https://api.example.com`, adjust a price and confirm. You get the gate config to paste into a Hono app, and the routes appear in the **Directory** straight away.
- **Webhooks** lists the events a seller receives (charge recorded, tab settled, payout sent).
- **Payouts CSV** downloads the payout from step 6.

### 8. Analytics

Both dashboards are built with AG Studio.

- **Seller analytics** has three pages. *Revenue* shows earned, collected, paid out, PayPal fees and net, with a gross-to-net chart. *Demand* compares quotes with paid calls. *Payouts* holds the ledger. Click a donut slice or a treemap block and the rest of the page filters to it. **Edit / Ask AI** opens the revenue agent; ask *"Why did revenue change today vs yesterday?"*.
- **Analytics** (buyer) shows spend by agent and seller, a bar for today's spend against the daily budget, and a *Spend guard* page with every decision and which rule made it.

AG Studio shows a "For Trial Use Only" watermark unless `AG_STUDIO_LICENSE_KEY` is set in `.env`.

### 9. Optional: connect Claude Code

```sh
export DEMO_BUYER_API_KEY="$(grep '^DEMO_BUYER_API_KEY=' .env | cut -d= -f2-)"
claude mcp add --transport http tab402 http://localhost:4100/mcp \
  --header "Authorization: Bearer $DEMO_BUYER_API_KEY" --header "X-Tab402-Agent: Claude Code"
```

Or run `claude mcp add --transport http tab402 http://localhost:4100/mcp` with no headers and sign in through the browser when Claude Code asks (OAuth 2.1 with PKCE). Then ask *"Find a paid API that can summarize text and use it on this note: …"*. Remove it afterwards with `claude mcp remove tab402`.

## What works without which key

| Feature | Needs |
|---|---|
| Paying per call, receipts, budgets, approvals, analytics | Nothing beyond setup |
| Worker (settlement jobs) | PayPal sandbox client ID and secret |
| Saving a wallet in the web app | PayPal sandbox app and a sandbox personal account |
| `settle-sandbox.ts` (real capture and payout) | PayPal sandbox app with Vault and Payouts enabled |
| Spend guard model, pricing agent, revenue agent, real summaries | `ANTHROPIC_API_KEY`. Without it, labelled stand-ins answer |
| Push notifications | VAPID keys (`setup.sh` generates them) and Chrome |
| No dashboard watermark | `AG_STUDIO_LICENSE_KEY` |

## Troubleshooting

| You see | Do |
|---|---|
| `Port 3000 is already in use` | Stop the other process: `lsof -iTCP:3000 -sTCP:LISTEN` shows it |
| Playground says "MCP server offline" | The backend isn't running. Start `./demo/start.sh` and wait for `Tab402 is up` |
| `Docker is installed but not running` | Start Docker Desktop or OrbStack, then re-run `setup.sh` |
| Seller pages are empty | Run `./demo/link-seller.sh` after signing up |
| Opening `localhost:4200/v1/summarize` gives 404 | Expected. It only accepts a paid POST from an agent |
| PayPal steps take 5 to 15 seconds | The sandbox is slow at times |

## Reset or stop

```sh
# Ctrl-C in the start.sh terminal, then:
docker compose stop                       # keep the data
pnpm db:down && docker volume rm tab402_tab402-pg && ./demo/setup.sh   # start fresh
```
