# Tab402 demo for judges

There are two ways to try Tab402:

- **Hosted site**: https://tab402-web.onrender.com. Nothing to install. Sign in with the shared demo login and start at the walkthrough.
- **On your machine**: about ten minutes of setup, after which you have your own copy with every key and script.

Both run against the PayPal sandbox, so no real money moves. The walkthrough is the same for both. Where a step differs, it has a separate part for the hosted site and for localhost.

## Contents

- [Option A: the hosted site](#option-a-the-hosted-site)
- [Option B: run it on your machine](#option-b-run-it-on-your-machine)
- [Walkthrough](#walkthrough)
  - [1. Look around signed out](#1-look-around-signed-out)
  - [2. Sign in](#2-sign-in)
  - [3. Let an agent pay](#3-let-an-agent-pay)
  - [4. Approve a purchase from the agent](#4-approve-a-purchase-from-the-agent)
  - [5. Budgets and the spend guard](#5-budgets-and-the-spend-guard)
  - [6. Settle the tab on PayPal](#6-settle-the-tab-on-paypal)
  - [7. The seller side](#7-the-seller-side)
  - [8. Analytics](#8-analytics)
  - [9. Optional: connect Claude Code](#9-optional-connect-claude-code)
- [What works without which key (local)](#what-works-without-which-key-local)
- [Troubleshooting](#troubleshooting)
- [Reset or stop (local)](#reset-or-stop-local)

## Option A: the hosted site

Everything runs on Render: the web app, API, MCP server, demo seller, worker, and the settlement workflow with its cron job.

| Service | URL |
|---|---|
| Web app | https://tab402-web.onrender.com |
| Facilitator API reference | https://tab402-api.onrender.com/docs |
| MCP server for agents | https://tab402-mcp.onrender.com/mcp |
| Demo seller (a paid API) | https://tab402-sellers.onrender.com/openapi.json |

**Shared demo login**

| Email | Password |
|---|---|
| `buyer@example.com` | `tab402-judges` |

This account already has a $10 prepaid balance, an agent, a saved PayPal sandbox wallet and the demo seller, so every page has data. You need Chrome or another browser with passkeys.

The account is shared by every judge. Please leave it as you found it:

- Turn **Ask me before every purchase** off when you finish step 4.
- Don't revoke the **Playground** agent or remove the wallet.

**Your own account instead.** Sign up with any email and a password of 10 or more characters. A new account starts with no funding, so the agent's calls are refused until you save a wallet. Go to **Wallet** and save one with a PayPal sandbox personal account. To get one, sign up free at [developer.paypal.com](https://developer.paypal.com), then look under Testing Tools, Sandbox Accounts. The seller pages stay empty on your own account because the demo seller belongs to the shared one.

Then go to the [walkthrough](#walkthrough).

## Option B: run it on your machine

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

```sh
git clone https://github.com/0xhaz/Tab402.git && cd Tab402
./demo/setup.sh     # checks tools, writes .env, installs, starts Postgres, migrates, seeds, builds
./demo/start.sh     # starts every service; Ctrl-C stops them
```

`setup.sh` asks for your PayPal sandbox client ID and secret, and optionally an Anthropic key. It generates every other secret itself and never prints them. You can re-run it safely, because it only fills values that are empty.

When `start.sh` prints `Tab402 is up`, open http://localhost:3000.

| Service | URL |
|---|---|
| Web app | http://localhost:3000 |
| Facilitator API and its reference | http://localhost:4000/docs |
| MCP server for agents | http://localhost:4100/mcp |
| Demo seller (a paid API) | http://localhost:4200/openapi.json |

## Walkthrough

In the steps below, "the web app" means https://tab402-web.onrender.com on the hosted site or http://localhost:3000 locally.

### 1. Look around signed out

Open the web app in a private window. The landing page has a slider that compares the card fees of charging for every call separately with the fees on one Tab402 tab. **Directory** lists the paid APIs agents can buy, with no sign-in. You should see "Summarize text" ($0.01) and "Chat with a model" (metered) from Tab402 Demo Sellers.

### 2. Sign in

**Hosted site.** Click **Sign in** and use the shared demo login. Then open **Security & alerts** and add a passkey (Touch ID or your device PIN). Approvals are confirmed with a passkey, and a passkey on another judge's device won't work on yours. Turning on notifications here is optional. On a shared account, approval pushes go to every browser that turned them on. You can also turn on **Email me approval requests** and enter your own address. The account has one address, so turn it off when you're done.

**Localhost.** Click **Get started** and sign up with the email `buyer@example.com`, any name and any password of 10 or more characters. That email claims the seeded demo buyer, which already has a $10 prepaid balance and an agent. Two optional extras:

- **Security & alerts**: add a passkey and turn on notifications. Approval requests then arrive as a push, and you approve with the passkey. With `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`, you can turn on **Email me approval requests** as well.
- **Wallet**: save a PayPal sandbox wallet with the sandbox personal account. The PayPal popup uses the JS SDK v6 save flow and stores a Vault token.

You land on **Overview**, which shows the balance.

### 3. Let an agent pay

Open **Agent playground** in the sidebar. It talks to the MCP server the same way Claude Code or any other agent would, as an agent named "Playground". It should say "Connected · 7 tools".

Click the steps in order and watch the Activity column:

1. **Check my budget** shows the $10 daily budget.
2. **Find a summarizer** searches the directory and finds the demo seller's `POST /v1/summarize` at $0.01. Agents call that URL. Opening it in a browser gives 404, because it only takes a paid POST.
3. **Summarize the note** pays one cent and returns the summary.
4. **Chat (metered)** charges what the call actually cost, up to its $0.05 ceiling.

Keep **Receipts** open in another tab. New rows appear within a few seconds without reloading, each with what the agent said it was buying.

### 4. Approve a purchase from the agent

Back in the playground, turn on **Ask me before every purchase**. That sets the approval threshold to half a cent, so every call now needs your OK.

Click **Summarize the note** again. The card turns amber and shows **Open approval page**. If notifications are on, a push arrives too. With email on, an email arrives with **Review and approve** and **Decline** buttons. Decline from the email works without signing in, after one click on the page it opens. Approve with your passkey, then click **Run again after approving**. The call goes through and is charged once. Try it again and press **Decline** instead: the agent is told it was declined and nothing is charged.

Turn the switch off when you're done.

### 5. Budgets and the spend guard

- **Make a $0.02 sub-budget**, then **Summarize with the sub-budget** three times. The first two pay, and the cap refuses the third.
- **Off-purpose purchase** asks for a summary for something that doesn't match. The spend guard checks fixed rules first: budgets, allow and block lists, the per-call maximum and the approval threshold. Unusual cases, such as a first-time seller or a price spike, go to Claude Haiku 4.5, which approves, denies or asks you. The reason shows on **Approvals** and **Analytics**.
- **Agents & keys** lets you revoke an agent, and its next call is refused. On the hosted site, revoke one you made, not **Playground**.

### 6. Settle the tab on PayPal

**Hosted site.** Settlement runs by itself. Every 15 minutes a Render cron job starts the settlement workflow, which runs each buyer's settlement as its own task.

- The shared account is prepaid, so the calls you made move from *earned* to *collected* in **Receipts** after the next run, within 15 minutes.
- When a prepaid balance runs low, the workflow tops it up from the saved PayPal wallet in one merchant-initiated charge.
- A post-paid tab is captured once it reaches $10 or is 24 hours old, again in one charge for the whole tab. New wallets start prepaid, and post-paid unlocks after three successful PayPal charges.
- Sellers are paid with PayPal Payouts: daily at 01:00 UTC once they are owed $20, and weekly on Monday at 00:00 UTC. Paid calls then show *paid out*.

The demo video shows the workflow's runs in the Render dashboard.

**Localhost.** The worker settles on its own when a tab reaches $10 or is 24 hours old. To see it now, run these in a new terminal from the repo root. Your sandbox app needs Vault and Payouts turned on (developer.paypal.com, your app, Features).

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

**Hosted site.** The demo seller already belongs to the shared account. Open **Selling**. The demo spec for **Add from OpenAPI** below is at https://tab402-sellers.onrender.com/openapi.json.

**Localhost.** Make the seeded demo seller belong to your account so its traffic shows up, then open **Selling**. The demo spec for **Add from OpenAPI** below is at http://localhost:4200/openapi.json. Don't click **Become a seller** first, because that makes a new, empty seller.

```sh
./demo/link-seller.sh
```

On **Selling**:

- Tiles for earned, collected and paid out, and the demo endpoints.
- **Add from OpenAPI**: the box takes the spec itself, not its URL. Open the spec URL in a new tab, copy all of the JSON, paste it into the box and click **Propose prices**. You can also save the file and use **or load a file**. Claude Sonnet 5.5 reads the spec and proposes a price per route, leaving `/health` free. Set the base URL to something like `https://api.example.com`, adjust a price and confirm. If you keep a base URL whose routes are already live, such as the demo seller's own, Tab402 lists what would change and asks before updating them. It refuses to switch a live route between fixed and metered pricing. You get the gate config to paste into a Hono app, and the routes appear in the **Directory** straight away.
- **Webhooks** lists the events a seller receives (charge recorded, tab settled, payout sent).
- **Payouts CSV** downloads the payouts made so far.

### 8. Analytics

Both dashboards are built with AG Studio.

- **Seller analytics** has three pages:
  - *Revenue* shows earned, collected, paid out, PayPal fees and net, with a gross-to-net chart.
  - *Demand* compares quotes with paid calls.
  - *Payouts* holds the ledger.

  Click a donut slice or a treemap block and the rest of the page filters to it. **Edit / Ask AI** opens the revenue agent. Ask *"Why did revenue change today vs yesterday?"*.
- **Analytics** (buyer) shows spend by agent and seller, a bar for today's spend against the daily budget, and a *Spend guard* page with every decision and which rule made it.

AG Studio shows a "For Trial Use Only" watermark unless `AG_STUDIO_LICENSE_KEY` is set.

### 9. Optional: connect Claude Code

**Hosted site.** Add the MCP server, then sign in through the browser when Claude Code asks (OAuth 2.1 with PKCE). Use the shared login or your own account.

```sh
claude mcp add --transport http tab402 https://tab402-mcp.onrender.com/mcp
```

**Localhost.** Use the demo buyer's API key from `.env`:

```sh
export DEMO_BUYER_API_KEY="$(grep '^DEMO_BUYER_API_KEY=' .env | cut -d= -f2-)"
claude mcp add --transport http tab402 http://localhost:4100/mcp \
  --header "Authorization: Bearer $DEMO_BUYER_API_KEY" --header "X-Tab402-Agent: Claude Code"
```

You can also leave out the headers and sign in through the browser, as on the hosted site.

Then ask *"Find a paid API that can summarize text and use it on this note: …"*. Remove it afterwards with `claude mcp remove tab402`.

## What works without which key (local)

| Feature | Needs |
|---|---|
| Paying per call, receipts, budgets, approvals, analytics | Nothing beyond setup |
| Worker (settlement jobs) | PayPal sandbox client ID and secret |
| Saving a wallet in the web app | PayPal sandbox app and a sandbox personal account |
| `settle-sandbox.ts` (real capture and payout) | PayPal sandbox app with Vault and Payouts enabled |
| Spend guard model, pricing agent, revenue agent, real summaries | `ANTHROPIC_API_KEY`. Without it, labelled stand-ins answer |
| Push notifications | VAPID keys (`setup.sh` generates them) and Chrome |
| Approval emails | `GMAIL_USER` and `GMAIL_APP_PASSWORD` (a Google App Password) for the worker, then **Email me approval requests** under Security & alerts |
| No dashboard watermark | `AG_STUDIO_LICENSE_KEY` |

## Troubleshooting

| Where | You see | Do |
|---|---|---|
| Both | Opening `/v1/summarize` on the demo seller gives 404 | Expected. It only accepts a paid POST from an agent |
| Both | PayPal steps take 5 to 15 seconds | The sandbox is slow at times |
| Hosted | "Passkey check was cancelled" when approving | Add your own passkey under **Security & alerts**, then approve again |
| Both | No approval email arrives | Check spam, and that **Email me approval requests** is on with the right address. Locally, the worker log says `approval emails are off` when the Gmail settings are missing |
| Hosted | Every call asks for approval as soon as you arrive | Another judge left **Ask me before every purchase** on. Turn it off |
| Hosted | The agent's calls are refused with `no_mandate` | You're on your own account. Save a wallet on **Wallet** first |
| Hosted | The API or seller root URL gives 404 | Expected. Use `/docs` on the API and `/openapi.json` on the seller |
| Local | `Port 3000 is already in use` | Stop the other process: `lsof -iTCP:3000 -sTCP:LISTEN` shows it |
| Local | Playground says "MCP server offline" | The backend isn't running. Start `./demo/start.sh` and wait for `Tab402 is up` |
| Local | `Docker is installed but not running` | Start Docker Desktop or OrbStack, then re-run `setup.sh` |
| Local | Seller pages are empty | Run `./demo/link-seller.sh` after signing up |

## Reset or stop (local)

```sh
# Ctrl-C in the start.sh terminal, then:
docker compose stop                       # keep the data
pnpm db:down && docker volume rm tab402_tab402-pg && ./demo/setup.sh   # start fresh
```
