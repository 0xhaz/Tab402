import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  HEADERS,
  isTabRequirements,
  type PaymentRequired,
  signVoucher,
  type TabRequirements,
} from "@tab402/core";
import { schema as s } from "@tab402/db";
import {
  MemoryChannelStore,
  PaymentError,
  type Receipt,
  registerAgentKey,
  Tab402Client,
} from "@tab402/sdk-client";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS } from "./harness";

const h = await createHarness();
afterAll(h.close);

const summarize = (
  text = "Tab402 settles agent payments in batches. It uses PayPal. Fees drop a lot.",
) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
const chat = (message = "Explain cumulative vouchers in one paragraph.") => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message }),
});

async function newAgent(name = "Claude Code") {
  return registerAgentKey({
    apiUrl: API,
    buyerApiKey: h.buyerKey,
    agentName: name,
    fetch: h.router,
  });
}

function client(
  agent: Awaited<ReturnType<typeof newAgent>>,
  extra: Partial<ConstructorParameters<typeof Tab402Client>[0]> = {},
) {
  return new Tab402Client({
    keyId: agent.keyId,
    privateKey: agent.privateKey,
    fetch: h.router,
    ...extra,
  });
}

/** Unpaid request → the 402 quote, for hand-built vouchers in negative tests. */
async function getQuote(
  path = "/v1/summarize",
): Promise<{ required: PaymentRequired; req: TabRequirements }> {
  const res = await h.router(`${SELLERS}${path}`, path.endsWith("chat") ? chat() : summarize());
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get(HEADERS.paymentRequired) ?? "");
  const req = required.accepts.find(isTabRequirements);
  if (!req) throw new Error("no tab entry");
  return { required, req };
}

async function payManually(
  agent: Awaited<ReturnType<typeof newAgent>>,
  req: TabRequirements,
  fields: { channelId: string; seq: number; cumulative: string; expiresAt?: number },
  signer = agent.privateKey,
) {
  const voucher = await signVoucher(
    {
      channelId: fields.channelId,
      keyId: agent.keyId,
      seq: fields.seq,
      cumulative: fields.cumulative,
      quoteId: req.extra.quoteId,
      expiresAt: fields.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
    },
    signer,
  );
  const header = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: req,
    payload: { ...voucher },
  });
  const res = await h.router(`${SELLERS}/v1/summarize`, {
    ...summarize(),
    headers: { "content-type": "application/json", [HEADERS.paymentSignature]: header },
  });
  const again = res.headers.get(HEADERS.paymentRequired);
  return { res, error: again ? decodePaymentRequiredHeader(again).error : undefined, header };
}

describe("402 handshake", () => {
  beforeEach(() => h.reset());

  it("returns a v2 PAYMENT-REQUIRED with a tab entry and logs the quote", async () => {
    const { required, req } = await getQuote();
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe(`${SELLERS}/v1/summarize`);
    expect(req).toMatchObject({
      scheme: "tab",
      network: "tab402:sandbox",
      asset: "USD",
      amount: "10000",
    });
    expect(req.extra).toMatchObject({ decimals: 6, pricing: "fixed", facilitator: API });
    const quotes = await h.db.select().from(s.quotes);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.status).toBe("issued");
  });

  it("passes unpriced routes through and exposes /supported", async () => {
    expect((await h.router(`${SELLERS}/health`)).status).toBe(200);
    const supported = (await (await h.router(`${API}/supported`)).json()) as {
      kinds: { scheme: string }[];
    };
    expect(supported.kinds.map((k) => k.scheme)).toEqual(["tab", "tab"]);
  });

  it("rejects facilitator calls without a seller key", async () => {
    const res = await h.router(`${API}/verify`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    const asBuyer = await h.router(`${API}/quotes`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.buyerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", url: `${SELLERS}/v1/summarize` }),
    });
    expect(asBuyer.status).toBe(401);
  });
});

describe("paid calls (Phase 2 exit)", () => {
  beforeEach(() => h.reset());

  it("50 fixed + 50 metered calls → 100 earned charges with exact cumulative totals", async () => {
    const agent = await newAgent();
    const receipts: Receipt[] = [];
    const c = client(agent, { onPayment: (r) => receipts.push(r) });
    const latencies: number[] = [];
    h.timings.clear();

    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = await c.fetch(`${SELLERS}/v1/summarize`, summarize());
      latencies.push(performance.now() - t0);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { summary: string }).summary).toContain("[mock]");
      const r2 = await c.fetch(`${SELLERS}/v1/chat`, chat());
      expect(r2.status).toBe(200);
      const body = (await r2.json()) as { costMicros: number };
      expect(body.costMicros).toBeGreaterThan(0);
      expect(body.costMicros).toBeLessThanOrEqual(50_000);
    }

    const charges = await h.db.select().from(s.charges);
    expect(charges).toHaveLength(100);
    expect(charges.every((ch) => ch.state === "earned" && ch.prepaid)).toBe(true);
    const total = charges.reduce((a, ch) => a + ch.amountMicros, 0);
    expect(receipts.reduce((a, r) => a + r.chargedMicros, 0)).toBe(total);

    const [channel] = await h.db.select().from(s.channels);
    expect(channel).toMatchObject({ lastSeq: 100, cumulativeRecordedMicros: total });

    const [balance] = await h.db.select().from(s.balances);
    expect(balance?.balanceMicros).toBe(10_000_000 - total);

    const fixed = charges.filter((ch) => ch.amountMicros === 10_000);
    expect(fixed.length).toBeGreaterThanOrEqual(50);
    const quotes = await h.db.select().from(s.quotes);
    expect(quotes.filter((q) => q.status === "paid")).toHaveLength(100);

    const pct = (xs: number[], q: number) =>
      [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))] ?? 0;
    const verify = h.timings.get("/verify") ?? [];
    const settle = h.timings.get("/settle") ?? [];
    const overhead = verify.map((v, i) => v + (settle[i] ?? 0));
    console.log(
      `  verify p50 ${pct(verify, 0.5).toFixed(1)} ms · settle p50 ${pct(settle, 0.5).toFixed(1)} ms`,
    );
    console.log(
      `gate overhead (verify + settle/ledger write), n=${overhead.length}: p50 ${pct(overhead, 0.5).toFixed(1)} ms, p95 ${pct(overhead, 0.95).toFixed(1)} ms` +
        ` | full paid call incl. 402 + quote: p50 ${pct(latencies, 0.5).toFixed(1)} ms, p95 ${pct(latencies, 0.95).toFixed(1)} ms`,
    );
  });

  it("keeps seq ordered under concurrent calls to one seller", async () => {
    const agent = await newAgent();
    const c = client(agent);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.fetch(`${SELLERS}/v1/summarize`, summarize())),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const [channel] = await h.db.select().from(s.channels);
    expect(channel?.lastSeq).toBe(20);
  });

  it("records metered actuals, never more than the quoted max", async () => {
    const agent = await newAgent();
    const res = await client(agent).fetch(`${SELLERS}/v1/chat`, chat("x ".repeat(4_000)));
    expect(res.status).toBe(200);
    const [charge] = await h.db.select().from(s.charges);
    expect(charge?.authorizedMicros).toBe(50_000);
    expect(charge?.amountMicros).toBeLessThanOrEqual(50_000);
    const body = (await res.json()) as { costMicros: number };
    expect(charge?.amountMicros).toBe(Math.min(body.costMicros, 50_000));
  });

  it("does not charge when the handler fails", async () => {
    const agent = await newAgent();
    const res = await client(agent).fetch(`${SELLERS}/v1/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: true }),
    });
    expect(res.status).toBe(400);
    expect(await h.db.select().from(s.charges)).toHaveLength(0);
  });
});

describe("replay and voucher rules", () => {
  // Hand-built vouchers test protocol mechanics; the spend guard has its own suite.
  beforeEach(async () => {
    await h.reset();
    h.setGuard(false);
  });

  it("rejects a replayed PAYMENT-SIGNATURE", async () => {
    const agent = await newAgent();
    const { req } = await getQuote();
    const first = await payManually(agent, req, {
      channelId: "ch_test1",
      seq: 1,
      cumulative: "10000",
    });
    expect(first.res.status).toBe(200);
    const replay = await h.router(`${SELLERS}/v1/summarize`, {
      ...summarize(),
      headers: { "content-type": "application/json", [HEADERS.paymentSignature]: first.header },
    });
    expect(replay.status).toBe(402);
    expect(
      decodePaymentRequiredHeader(replay.headers.get(HEADERS.paymentRequired) ?? "").error,
    ).toBe("quote_used");
    expect(await h.db.select().from(s.charges)).toHaveLength(1);
  });

  it.each([
    ["skipped seq", { channelId: "ch_t", seq: 2, cumulative: "10000" }, "seq_mismatch"],
    [
      "cumulative too low",
      { channelId: "ch_t", seq: 1, cumulative: "9999" },
      "insufficient_cumulative",
    ],
    [
      "expired voucher",
      { channelId: "ch_t", seq: 1, cumulative: "10000", expiresAt: 1_000 },
      "voucher_expired",
    ],
  ])("rejects %s", async (_n, fields, reason) => {
    const agent = await newAgent();
    const { req } = await getQuote();
    const out = await payManually(agent, req, fields);
    expect(out.res.status).toBe(402);
    expect(out.error).toBe(reason);
  });

  it("rejects a voucher signed by another key", async () => {
    const agent = await newAgent();
    const other = await newAgent("Other");
    const { req } = await getQuote();
    const out = await payManually(
      agent,
      req,
      { channelId: "ch_t", seq: 1, cumulative: "10000" },
      other.privateKey,
    );
    expect(out.error).toBe("invalid_signature");
  });

  it("rejects revoked keys", async () => {
    const agent = await newAgent();
    await h.db
      .update(s.agentKeys)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(s.agentKeys.id, agent.keyId));
    h.keys.invalidate(agent.keyId); // Same effect as the ≤30 s cache TTL running out.
    await expect(client(agent).fetch(`${SELLERS}/v1/summarize`, summarize())).rejects.toMatchObject(
      { reason: "key_inactive" },
    );
  });

  it("resyncs a client that lost its channel state", async () => {
    const agent = await newAgent();
    const store = new MemoryChannelStore();
    const c1 = client(agent, { store });
    for (let i = 0; i < 3; i++)
      expect((await c1.fetch(`${SELLERS}/v1/summarize`, summarize())).status).toBe(200);

    const c2 = client(agent, { store: new MemoryChannelStore() }); // Fresh process, no local state.
    const res = await c2.fetch(`${SELLERS}/v1/summarize`, summarize());
    expect(res.status).toBe(200);
    const [channel] = await h.db.select().from(s.channels);
    expect(channel).toMatchObject({ lastSeq: 4, cumulativeRecordedMicros: 40_000 });
  });

  it("guard can deny before any voucher is signed", async () => {
    const agent = await newAgent();
    const c = client(agent, {
      guard: (q) =>
        q.amountMicros > 5_000 ? { outcome: "deny", reason: "too pricey" } : { outcome: "approve" },
    });
    await expect(c.fetch(`${SELLERS}/v1/summarize`, summarize())).rejects.toBeInstanceOf(
      PaymentError,
    );
    expect(await h.db.select().from(s.vouchers)).toHaveLength(0);
  });
});

describe("funding limits", () => {
  it("prepaid: stops at an empty balance", async () => {
    await h.reset({ balanceMicros: 15_000 });
    const agent = await newAgent();
    const c = client(agent);
    expect((await c.fetch(`${SELLERS}/v1/summarize`, summarize())).status).toBe(200);
    await expect(c.fetch(`${SELLERS}/v1/summarize`, summarize())).rejects.toMatchObject({
      reason: "balance_empty",
    });
    const [balance] = await h.db.select().from(s.balances);
    expect(balance?.balanceMicros).toBe(5_000);
  });

  it("post-paid: stops at the open-tab cap", async () => {
    await h.reset({ mode: "postpaid", creditLimitMicros: 20_000 });
    const agent = await newAgent();
    const c = client(agent);
    expect((await c.fetch(`${SELLERS}/v1/summarize`, summarize())).status).toBe(200);
    expect((await c.fetch(`${SELLERS}/v1/summarize`, summarize())).status).toBe(200);
    await expect(c.fetch(`${SELLERS}/v1/summarize`, summarize())).rejects.toMatchObject({
      reason: "tab_limit",
    });
    const charges = await h.db.select().from(s.charges);
    expect(charges.every((ch) => !ch.prepaid)).toBe(true);
    const [{ open } = { open: "0" }] = await h.db
      .select({ open: sql<string>`sum(${s.charges.amountMicros})` })
      .from(s.charges);
    expect(Number(open)).toBe(20_000);
  });
});

describe("OpenAPI", () => {
  beforeAll(() => h.reset());
  it("publishes the spec and docs page", async () => {
    const spec = (await (await h.router(`${API}/openapi.json`)).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/agent-keys",
      "/approvals",
      "/approvals/{id}/decide",
      "/balance/top-up",
      "/charges/{id}/flag",
      "/charges/{id}/refund",
      "/charges/{id}/resolve",
      "/directory",
      "/directory/categories",
      "/directory/sellers/{id}/x402",
      "/endpoints",
      "/events",
      "/guard/decide",
      "/policy",
      "/quotes",
      "/seller/payout",
      "/seller/webhook",
      "/seller/x402",
      "/settle",
      "/supported",
      "/verify",
      "/wallet/complete",
      "/wallet/setup",
    ]);
    expect((await h.router(`${API}/docs`)).status).toBe(200);
  });
});
