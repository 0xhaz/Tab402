/**
 * Pay the local demo sellers over real HTTP: registers a fresh agent key with the demo buyer's
 * API key, then makes fixed and metered calls through the Tab402 client.
 *   pnpm dev   (in another terminal)  →  npx tsx --env-file=.env scripts/demo/pay.ts [calls]
 */
import { formatUsd } from "@tab402/core";
import { registerAgentKey, Tab402Client } from "@tab402/sdk-client";

const api = process.env.TAB402_API_URL ?? "http://localhost:4000";
const sellers = process.env.DEMO_SELLERS_URL ?? "http://localhost:4200";
const buyerApiKey = process.env.DEMO_BUYER_API_KEY;
if (!buyerApiKey) throw new Error("DEMO_BUYER_API_KEY is not set");
const calls = Number(process.argv[2] ?? 3);

const agent = await registerAgentKey({ apiUrl: api, buyerApiKey, agentName: "demo-script" });
console.log(`agent key ${agent.keyId}`);

let total = 0;
const client = new Tab402Client({
  keyId: agent.keyId,
  privateKey: agent.privateKey,
  onPayment: (r) => {
    total += r.chargedMicros;
    console.log(
      `  paid ${formatUsd(r.chargedMicros).padStart(9)}  ${r.quote.pricing.padEnd(7)} ${r.url}  (${r.chargeId})`,
    );
  },
});

const post = (path: string, body: unknown) =>
  client.fetch(`${sellers}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

for (let i = 0; i < calls; i++) {
  const s = (await (
    await post("/v1/summarize", {
      text: "Agents pay per call. Tabs settle in batches through PayPal. Fees fall.",
    })
  ).json()) as { summary: string };
  const c = (await (
    await post("/v1/chat", { message: "What is a cumulative voucher?" })
  ).json()) as { reply: string };
  if (i === 0) console.log(`  summary: ${s.summary}\n  reply:   ${c.reply.slice(0, 80)}`);
}
console.log(`total ${formatUsd(total)} across ${calls * 2} calls`);
