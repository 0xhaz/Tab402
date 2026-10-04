/**
 * Real PayPal sandbox settlement, end to end:
 *   1. attach an approved PayPal vault token to the demo buyer as a post-paid mandate (sealed)
 *   2. pay the local demo sellers over HTTP (servers must be running: pnpm dev)
 *   3. run the capture job → ONE merchant-initiated PayPal charge for the whole tab
 *   4. run a payout to the seller and poll PayPal until it lands
 *
 *   npx tsx --env-file=.env scripts/demo/settle-sandbox.ts [calls=300] [payoutReceiver]
 * The vault token comes from scripts/sandbox/.sandbox-state.json (day-1 test 3).
 */
import { readFileSync } from "node:fs";
import { formatUsd, newId } from "@tab402/core";
import { createDb, parseMasterKey, schema as s, sealSecret } from "@tab402/db";
import { DEFAULT_LEDGER_CONFIG, JOBS } from "@tab402/ledger";
import { PayPalClient, PayPalPayouts, PayPalWalletFunding } from "@tab402/paypal";
import { registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import { createJobs } from "@tab402/worker/jobs";
import { and, eq, ne } from "drizzle-orm";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const calls = Number(process.argv[2] ?? 300);
const receiver = process.argv[3] ?? "sb-247jtl53192150@personal.example.com";
const state = JSON.parse(
  readFileSync(new URL("../sandbox/.sandbox-state.json", import.meta.url), "utf8"),
) as { vaultId?: string };
if (!state.vaultId)
  throw new Error(
    "no vaultId — run scripts/sandbox/2-vault-setup.ts and 3-vault-exchange.ts first",
  );

const { db, close } = createDb(env("DATABASE_URL"));
const masterKey = parseMasterKey(env("TAB402_MASTER_KEY"));
const paypal = new PayPalClient({
  clientId: env("PAYPAL_CLIENT_ID"),
  clientSecret: env("PAYPAL_CLIENT_SECRET"),
  env: "sandbox",
});

try {
  // 1. Post-paid mandate on the approved wallet.
  const buyer = await db.query.buyers.findFirst({
    where: (b, { eq }) => eq(b.email, "buyer@example.com"),
  });
  const seller = await db.query.sellers.findFirst({
    where: (x, { eq }) => eq(x.name, "Tab402 Demo Sellers"),
  });
  if (!buyer || !seller) throw new Error("run pnpm db:seed first");
  const mandateId = newId("mandate");
  const secretId = newId("secret");
  await db.transaction(async (tx) => {
    await tx.insert(s.merchantSecrets).values({
      id: secretId,
      ownerId: mandateId,
      kind: "vault_token",
      blob: sealSecret(masterKey, mandateId, "vault_token", state.vaultId as string),
    });
    await tx
      .update(s.mandates)
      .set({ status: "revoked" })
      .where(and(eq(s.mandates.buyerId, buyer.id), ne(s.mandates.status, "revoked")));
    await tx.insert(s.mandates).values({
      id: mandateId,
      buyerId: buyer.id,
      rail: "paypal_wallet",
      mode: "postpaid",
      status: "active",
      vaultSecretId: secretId,
      creditLimitMicros: 25_000_000,
    });
    await tx
      .update(s.agentKeys)
      .set({ status: "active" })
      .where(and(eq(s.agentKeys.buyerId, buyer.id), eq(s.agentKeys.status, "frozen")));
    await tx.update(s.sellers).set({ payoutReceiver: receiver }).where(eq(s.sellers.id, seller.id));
  });
  console.log(
    `1. post-paid mandate ${mandateId} on vault ${state.vaultId.slice(0, 6)}…; seller payouts → ${receiver}`,
  );

  // 2. Paid calls over real HTTP.
  const api = process.env.TAB402_API_URL ?? "http://localhost:4000";
  const sellers = process.env.DEMO_SELLERS_URL ?? "http://localhost:4200";
  const agent = await registerAgentKey({
    apiUrl: api,
    buyerApiKey: env("DEMO_BUYER_API_KEY"),
    agentName: "sandbox-settlement",
  });
  const client = new Tab402Client({ keyId: agent.keyId, privateKey: agent.privateKey });
  const t0 = performance.now();
  for (let i = 0; i < calls; i++) {
    const res = await client.fetch(`${sellers}/v1/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Call ${i}. Agents pay per call; tabs settle in batches.` }),
    });
    if (res.status !== 200) throw new Error(`call ${i} failed: ${res.status}`);
  }
  console.log(`2. ${calls} paid calls in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  // 3 + 4. Worker jobs in-process with the real PayPal adapters.
  const queued: { name: string; data: object }[] = [];
  const jobs = createJobs({
    db,
    funding: new PayPalWalletFunding(paypal),
    payouts: new PayPalPayouts(paypal),
    masterKey,
    cfg: DEFAULT_LEDGER_CONFIG,
    enqueue: async (name, data) => {
      queued.push({ name, data });
    },
    log: {
      info: (o, m) => console.log(`   ${m}`, JSON.stringify(o)),
      warn: (o, m) => console.warn(`   ${m}`, o),
      error: (o, m) => console.error(`   ${m}`, o),
    },
  });

  await jobs[JOBS.capture]({ buyerId: buyer.id });
  const st = await db.query.settlements.findFirst({
    where: (x, { eq }) => eq(x.mandateId, mandateId),
  });
  console.log(
    `3. capture ${st?.status}: gross ${formatUsd(st?.grossMicros ?? 0)}, charged ${formatUsd(st?.capturedMicros ?? 0)}, ` +
      `PayPal fee ${formatUsd(st?.processorFeeMicros ?? 0)}, order ${st?.paypalOrderId}`,
  );
  if (st?.status !== "captured") throw new Error("capture did not complete");

  await jobs[JOBS.payoutRun]({ kind: "weekly" });
  const payout = await db.query.payouts.findFirst({ orderBy: (p, { desc }) => desc(p.createdAt) });
  if (!payout) throw new Error("no payout planned");
  for (let attempt = 1; attempt <= 20; attempt++) {
    await jobs[JOBS.payoutPoll]({ payoutId: payout.id, attempt: 99 }); // 99: don't self-reschedule
    const p = await db.query.payouts.findFirst({ where: (x, { eq }) => eq(x.id, payout.id) });
    if (p?.status !== "processing") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const final = await db.query.payouts.findFirst({ where: (x, { eq }) => eq(x.id, payout.id) });
  const items = await db.select().from(s.payoutItems).where(eq(s.payoutItems.payoutId, payout.id));
  console.log(
    `4. payout ${final?.status}: batch ${final?.paypalPayoutBatchId} (${final?.senderBatchId}), ` +
      items
        .map((i) => `${formatUsd(i.amountMicros)} → ${i.status}, fee ${formatUsd(i.feeMicros)}`)
        .join("; "),
  );
  const states = await db
    .select({ state: s.charges.state })
    .from(s.charges)
    .where(eq(s.charges.agentKeyId, agent.keyId));
  const counts: Record<string, number> = {};
  for (const r of states) counts[r.state] = (counts[r.state] ?? 0) + 1;
  console.log(`   this run's charges: ${JSON.stringify(counts)}`);
} finally {
  await close();
}
