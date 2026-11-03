# Tab402 demo video script

Target length 2:45, which leaves 15 seconds of slack under the 3-minute limit. The spoken lines come to about 400 words, a comfortable pace at 150 words a minute. Each scene lists what's on screen, then what you say.

The story runs in one direction: a seller prices an API, an agent finds it and pays, the buyer stays in control, PayPal settles it, and the seller sees the money.

## Before you record

- Start fresh: `pnpm db:down && docker volume rm tab402_tab402-pg && ./demo/setup.sh`, then `./demo/start.sh`.
- Sign up as `buyer@example.com`, add a passkey, turn on notifications, and save a sandbox wallet. Run `./demo/link-seller.sh`.
- Run the playground steps 1 to 4 a few times off camera, and run the settlement once (`demo/README.md` step 6), so the dashboards have data.
- Set `AG_STUDIO_LICENSE_KEY` in `.env` (the 45-day trial works) and rebuild, so the dashboards have no watermark.
- Set `DEMO_LLM=anthropic` so the summaries are real.
- Browser at 1440 × 900, light theme, zoom 110%. Hide bookmarks and other tabs. Turn on Do Not Disturb except for Chrome, so only the Tab402 push shows up.
- Deploy with `render.yaml` first, and let the cron job run a few times so the workflow's Runs page has history. If you record locally instead, show `scripts/demo/settle-sandbox.ts` in a terminal with a large font (18 pt or more).
- Use no music, or music you have the rights to. Keep other companies' logos off screen apart from PayPal, the sponsor. The playground avoids showing a third-party agent's interface; if you show Claude Code instead, check the rules on trademarks first.

## Scenes

### 0:00 to 0:15 · The problem

**Screen:** Landing page hero, then scroll to "Why a tab?" and drag the slider to 1,000 calls.

> AI agents want to buy API calls for a cent each. Card rails can't do that: a fee of about fifty cents per charge eats the whole cent. Tab402 lets agents pay per call, keeps a running tab, and settles it on PayPal in one charge.

### 0:15 to 0:45 · A seller prices an API in a minute

**Screen:** Selling, Add from OpenAPI. Paste `http://localhost:4200/openapi.json`, click Propose prices. The proposals appear. Change one price and confirm. Show the Gate config tab, then the Directory listing the routes.

> I'm a seller. I paste my OpenAPI spec, and Claude reads it and proposes a price for each route. It leaves the health check free. I adjust one price and confirm. Tab402 gives me a few lines of gate config for my server, and my routes are listed in the public directory where agents look for services.

### 0:45 to 1:15 · An agent finds it and pays

**Screen:** Agent playground. Click Check my budget, Find a summarizer, Summarize the note. Then switch to Receipts in a second tab, where the new row appears.

> Now the buyer's side. This is an agent connected over MCP, the same protocol Claude Code and other agents use. It checks its budget, searches the directory, and finds my summarizer at one cent. It calls the API, gets a 402 Payment Required, signs a voucher on its tab, and gets the summary back. On the buyer's Receipts page the charge shows up a few seconds later, with what the agent said it was buying.

### 1:15 to 1:50 · The buyer stays in control

**Screen:** Turn on Ask me before every purchase. Click Summarize the note. The amber card appears and the push notification slides in. Click it, approve with Touch ID, then click Run again after approving. Then click Make a $0.02 sub-budget and Summarize with the sub-budget three times; the third is refused.

> The buyer decides how much freedom the agent has. With "ask me first" on, the next purchase stops and asks. A push arrives on my laptop, I approve it with my passkey, and the agent finishes the call. Agents can also hand out small sub-budgets. This one has two cents, so the third call is refused. Anything unusual, like a new seller or a sudden spike, goes to a spend guard that can approve, deny, or ask me.

### 1:50 to 2:15 · PayPal settles the tab, on Render Workflows

**Screen:** The Render dashboard, tab402-settlement workflow, Runs. Open the latest `settleDueTabs` run so its `captureTab` children show, each with its status. Cut to Receipts, where the calls now say collected, then paid out.

> None of those cents went through PayPal one by one. They add up on the tab. Every fifteen minutes a Render cron job starts our settlement workflow. Each buyer's tab is captured as its own task run, in parallel, and Render retries a PayPal hiccup on its own. One merchant-initiated charge on the buyer's saved PayPal wallet covers the whole tab. Then PayPal Payouts pays the seller, and receipts move from earned to collected to paid out.

### 2:15 to 2:40 · The seller sees the money

**Screen:** Seller analytics, Revenue page. Point at the PayPal fees and Net to you tiles, then the gross-to-net chart. Click one slice of the revenue-by-buyer donut so the page filters. Open Edit / Ask AI and ask "Why did revenue change today vs yesterday?" Let the answer appear.

> Back to the seller. The dashboard, built with AG Grid's AG Studio, shows what was earned, collected and paid out, and what PayPal and Tab402 took on the way to net. One click on a buyer filters the whole page. And I can ask why revenue changed. The revenue agent queries my data and names the endpoints behind it.

### 2:40 to 2:45 · Close

**Screen:** Landing page hero, with the repo URL as a caption: github.com/0xhaz/Tab402.

> Tab402. Agents pay by the cent, and the money settles on PayPal.

## If you run long

Cut in this order:

1. The sub-budget part of scene 4 (saves about 10 seconds).
2. The Ask AI question in scene 6 (about 10 seconds).
3. The Directory shot in scene 2 (about 5 seconds).

## Features each scene shows

| Scene | Tab402 feature | PayPal or partner tool |
|---|---|---|
| The problem | Fee comparison | |
| Seller prices an API | Onboarding agent, gate config, directory | Claude Sonnet 5.5 |
| Agent pays | MCP server, x402 handshake, signed vouchers, live receipts | Model Context Protocol |
| Buyer in control | Approvals, passkeys, Web Push, sub-budgets, spend guard | Claude Haiku 4.5 (spend guard) |
| PayPal settles | One capture per tab, payouts, money states | Render Workflows and Cron Jobs, PayPal Vault v3, Orders v2, Payouts |
| Seller sees money | Revenue dashboard, cross-filtering, revenue agent | AG Studio (AG Grid), Claude Sonnet 5.5 |
