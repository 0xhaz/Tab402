# Tab402 demo video script

Target length 2:45, which leaves 15 seconds of slack under the 3-minute limit. The spoken lines come to about 400 words, a comfortable pace at 150 words a minute. Each scene lists what's on screen, then what you say.

The story runs in one direction: a seller prices an API, an agent finds it and pays, the buyer stays in control, PayPal settles it, and the seller sees the money.

Everything is recorded on the hosted site, https://tab402-web.onrender.com, so judges see the same app they can open.

## Before you record

- **Sign in.** Use the shared account (`buyer@example.com`) on https://tab402-web.onrender.com. Record before you share the login with judges. If they already have it, check that **Ask me before every purchase** is off and the Playground agent is active.
- **Set up this machine.** Passkeys are per device, so add one on the recording machine under **Security & alerts**. Turn on notifications in Chrome there too, and turn on **Email me approval requests** with your Gmail address. The worker on Render needs `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `tab402-secrets`. Send one test approval off camera and check it arrives.
- **Reset the seller scene.** Each take onboards Text Tools for real. Before the next take, run `DATABASE_URL=<tab402-db External Database URL> DEMO_SELLERS_URL=https://tab402-sellers.onrender.com npx tsx scripts/demo/reset-text-tools.ts` from the repo root, so the routes start unpriced again.
- **Seller link.** The demo seller must already be linked to the shared account (README, Deploy on Render, step 3).
- **Wallet.** Save a PayPal sandbox wallet on **Wallet**, and try **Top up** once off camera. Scene 5 needs both, and the sandbox app needs Vault turned on.
- **Data.** Run the playground steps 1 to 4 a few times off camera, then wait at least one 15-minute settlement run, so Receipts has collected rows next to the new ones.
- **Watermark.** Add `AG_STUDIO_LICENSE_KEY` to the `tab402-secrets` group on Render (the 45-day trial works) and redeploy `tab402-web`.
- **Real model output.** `DEMO_LLM=anthropic` is already set on Render, so the summaries come from Claude. Check that the Anthropic key has credit and a spending limit.
- **Windows.**
  - Chrome at 1440 × 900, light theme, zoom 110%, with no bookmarks bar or other tabs.
  - Do Not Disturb on except for Chrome, so only the Tab402 push shows up.
- **Wake the services.** Render's starter plan doesn't spin services down, but open each URL once before recording, because the first request after a deploy is slower.
- **If the hosted site is down,** record locally with `./demo/setup.sh` and `./demo/start.sh`. In scene 5, run `scripts/demo/settle-sandbox.ts` in a terminal at 18 pt or larger in place of the top-up.
- **Music and logos.** Use no music, or music you have the rights to. Keep other companies' logos off screen apart from PayPal, the sponsor. The playground keeps a third-party agent's interface off screen. If you show Claude Code instead, check the rules on trademarks first.

## Scenes

### 0:00 to 0:15 · The problem

**Screen:** Landing page hero, then scroll to "Why a tab?" and drag the slider to 1,000 calls.

> AI agents want to buy API calls for a cent each. The classic payment rails can't do that: a fee of about fifty cents per charge can eats the whole cent. Tab402 lets agents pay per call, keeps a running tab, and settles it on PayPal in one charge.

### 0:15 to 0:45 · A seller prices an API in a minute

**Screen:** Selling, Add from OpenAPI. The API on camera is **Tab402 Text Tools** (translate and keywords), a second demo API on the seller service that has no prices until you confirm them. Don't use the Demo Sellers spec here: its routes are already live, so onboarding it again stops with a warning.
1. Paste the spec JSON and click Propose prices. Copy it beforehand from https://tab402-sellers.onrender.com/tools/openapi.json, because the box takes the spec itself, not its URL. The base URL fills in as `https://tab402-sellers.onrender.com/tools`.
2. The proposals appear, with the health check left free. Change the keywords price and click Confirm.
3. Show the Gate config tab, then the Directory, where translate and keywords now sit next to the summarizer.

> Now I'm a seller. I paste my OpenAPI spec, and Claude reads it and proposes a price for each route. It leaves the health check free. I change one price and confirm. Tab402 gives me a few lines of gate config for my server, and my routes show up in the public directory where agents look for services.

### 0:45 to 1:15 · An agent finds it and pays

**Screen:** Agent playground. Click Check my budget, Find a summarizer, Summarize the note, then Chat (metered). Point at the chat's `paid.amount`, a fraction of a cent. Then switch to Receipts in a second tab, where the new rows appear.

> Now the buyer's side. This agent connects over MCP, the protocol Claude Code and other agents use. It checks its budget and finds my summarizer at one cent. It calls the API, gets a 402 Payment Required, signs a voucher on its tab, and gets the summary back. A metered chat is charged its real cost, less than a tenth of a cent. Each charge reaches the buyer's Receipts within seconds.

### 1:15 to 1:50 · The buyer stays in control

**Screen:**
1. Turn on Ask me before every purchase and click Summarize the note.
2. The amber card appears and the push notification slides in. The email arrives too, but keep the mail app off screen. Click the push, approve with Touch ID, then click Run again after approving.
3. Turn Ask me before every purchase off again, or every sub-budget call would stop for approval too.
4. Click Make a $0.02 sub-budget (button 5), then Summarize with the sub-budget (button 6) three times. The first two pay and the third is refused.

> The buyer decides how much freedom the agent has. With "ask me first" on, the next purchase stops and asks. A push arrives on my laptop and an email in my inbox. I approve with my passkey, and the agent finishes the call. Agents can also hand out small sub-budgets. This one has two cents, so the third call is refused. Anything unusual, like a new seller or a sudden spike, goes to a spend guard that can approve, deny, or ask me. And the tab settles by itself from a Render workflow that runs every fifteen minutes.

### 1:50 to 2:15 · PayPal settles the tab

**Screen:**
1. In the playground, click Show my tab (button 8). The Activity column shows the open total and the number of calls from scenes 3 and 4, including the metered chat at its real cost. Settlement runs at :00, :15, :30 and :45 and empties the tab, so record scenes 3 to 5 in one take that starts just after one of those times.
2. Open Wallet. Point at the saved PayPal wallet and the prepaid balance, then click Top up. Cut the few seconds the sandbox takes.
3. Open Receipts. Today's calls say earned, next to older rows that say collected and paid out.

> None of those cents went through PayPal one by one. They add up on the agent's tab, the summaries and that tiny chat alike. I saved my PayPal wallet once, with PayPal Vault, so Tab402 can charge it without a checkout page. My balance tops up in one merchant-initiated charge. Then PayPal Payouts pays the seller, and receipts move from earned to collected to paid out.

### 2:15 to 2:40 · The seller sees the money

**Screen:**
1. Seller analytics, Revenue page. Point at the PayPal fees and Net to you tiles, then the gross-to-net chart.
2. Click one slice of the revenue-by-buyer donut so the page filters.
3. Open Edit / Ask AI and ask "Why did revenue change today vs yesterday?" Let the answer appear.

> Back to the seller. The dashboard, built with AG Grid's AG Studio, shows what was earned, collected and paid out, and what PayPal and Tab402 took on the way to net. One click on a buyer filters the whole page. And I can ask why revenue changed. The revenue agent queries my data and names the endpoints behind it.

### 2:40 to 2:45 · Close

**Screen:** Landing page hero, with two captions: tab402-web.onrender.com and github.com/0xhaz/Tab402.

> Tab402. Agents pay by the cent, and the money settles on PayPal. Try it at the link below.

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
| Agent pays | MCP server, x402 handshake, signed vouchers, fixed and metered pricing, live receipts | Model Context Protocol |
| Buyer in control | Approvals, passkeys, Web Push and email alerts, sub-budgets, spend guard | Claude Haiku 4.5 (spend guard), Gmail SMTP |
| Buyer in control (narration) | Settlement every 15 minutes | Render Workflows and Cron Jobs |
| PayPal settles | The agent's tab, saved wallet, prepaid top-up, money states | PayPal Vault v3, Orders v2, Payouts |
| Seller sees money | Revenue dashboard, cross-filtering, revenue agent | AG Studio (AG Grid), Claude Sonnet 5.5 |
| Close | Hosted on Render | Render web services, worker, Postgres |
