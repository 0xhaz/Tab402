import { formatUsd, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { JOBS } from "@tab402/ledger";
import { registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, MERCHANT_HOOK, paypalFee, SELLERS, SELLERS2 } from "./harness";

const h = await createHarness();
afterAll(h.close);

const DAY = 24 * 3600_000;
/** Tabs under $1 roll over until they're 30 days old, so tiny test tabs jump past that. */
const PAST_SMALL_TAB_AGE = 31 * DAY;
const body = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Settle this tab. It spans sellers." }),
};

async function agent() {
  const a = await registerAgentKey({
    apiUrl: API,
    buyerApiKey: h.buyerKey,
    agentName: "settlement-test",
    fetch: h.router,
  });
  return new Tab402Client({ keyId: a.keyId, privateKey: a.privateKey, fetch: h.router });
}

async function api(path: string, key: string, init: { method?: string; body?: unknown } = {}) {
  const res = await h.router(`${API}${path}`, {
    method: init.method ?? "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const states = async () => {
  const rows = await h.db.select({ state: s.charges.state }).from(s.charges);
  return rows.reduce<Record<string, number>>((a, r) => {
    a[r.state] = (a[r.state] ?? 0) + 1;
    return a;
  }, {});
};

describe("Phase 3 exit: many calls → one capture → payouts", () => {
  beforeEach(() => h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 }));

  it("500 calls across two sellers settle as ONE PayPal capture, then one payout batch", async () => {
    const client = await agent();
    for (let i = 0; i < 500; i++) {
      const res = await client.fetch(`${i % 2 ? SELLERS2 : SELLERS}/v1/summarize`, body);
      expect(res.status).toBe(200);
    }
    expect(await states()).toEqual({ earned: 500 });

    // $5.00 isn't due yet; 25 h after the first charge it is.
    await h.worker[JOBS.scan]();
    expect(h.queued.filter((j) => j.name === JOBS.capture)).toHaveLength(0);
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    await h.worker[JOBS.scan]();
    await h.drain();

    expect(h.paypal.captures).toHaveLength(1);
    const capture = h.paypal.captures[0];
    expect(capture?.amountMicros).toBe(5_000_000);
    expect(capture?.vaultToken).toBe("VAULT-FAKE");
    expect(capture?.lines.map((l) => l.description).sort()).toEqual([
      "Demo Sellers — 250 paid calls",
      "Second Seller — 250 paid calls",
    ]);
    expect(await states()).toEqual({ collected: 500 });

    const [st] = await h.db.select().from(s.settlements);
    expect(st).toMatchObject({
      status: "captured",
      grossMicros: 5_000_000,
      capturedMicros: 5_000_000,
      processorFeeMicros: paypalFee(5_000_000),
    });
    const items = await h.db.select().from(s.settlementItems);
    expect(items.reduce((a, i) => a + i.processorFeeMicros, 0)).toBe(paypalFee(5_000_000));
    const net = items.reduce((a, i) => a + i.netMicros, 0);

    await h.worker[JOBS.payoutRun]({ kind: "weekly" });
    await h.drain(true);
    expect(h.paypal.payouts).toHaveLength(1);
    expect(h.paypal.payouts[0]?.items).toHaveLength(2);
    const paid = h.paypal.payouts[0]?.items.reduce((a, i) => a + i.amountMicros, 0) ?? 0;
    expect(net - paid).toBeLessThan(2 * 10_000); // only sub-cent carries stay behind
    expect(await states()).toEqual({ paid_out: 500 });
    const [payout] = await h.db.select().from(s.payouts);
    expect(payout?.status).toBe("success");

    // The pitch number: 500 separate PayPal charges vs one tab capture.
    const separate = 500 * paypalFee(10_000);
    const tab = paypalFee(5_000_000);
    console.log(
      `fees on $5.00 of calls — 500 separate charges: ${formatUsd(separate)} (${((separate / 5_000_000) * 100).toFixed(0)}%), ` +
        `one tab capture: ${formatUsd(tab)} (${((tab / 5_000_000) * 100).toFixed(1)}%)`,
    );
    expect(tab).toBeLessThan(separate / 100);
  });

  it("hitting the open-tab cap triggers an immediate capture", async () => {
    await h.reset({ mode: "postpaid", creditLimitMicros: 30_000 });
    const client = await agent();
    for (let i = 0; i < 3; i++) await client.fetch(`${SELLERS}/v1/summarize`, body);
    await expect(client.fetch(`${SELLERS}/v1/summarize`, body)).rejects.toMatchObject({
      reason: "tab_limit",
    });
    expect(h.queued.map((j) => j.name)).toContain(JOBS.capture);
    await h.drain();
    // $0.03 tab + nothing carried: captured, so the buyer can keep going.
    expect(h.paypal.captures[0]?.amountMicros).toBe(30_000);
    expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
  });

  it("a declined capture freezes the buyer; the retry 24 h later succeeds and unfreezes", async () => {
    const client = await agent();
    for (let i = 0; i < 3; i++) await client.fetch(`${SELLERS}/v1/summarize`, body);
    h.paypal.declineNext = 1;
    h.setClock(() => new Date(Date.now() + PAST_SMALL_TAB_AGE));
    await h.worker[JOBS.scan]();
    await h.drain();
    expect(h.queued).toMatchObject([
      { name: JOBS.retryCapture, options: { startAfter: 24 * 3600 } },
    ]);
    // The frozen mandate stops payments immediately (mandates aren't cached; keys follow within 30 s).
    await expect(client.fetch(`${SELLERS}/v1/summarize`, body)).rejects.toMatchObject({
      reason: "no_mandate",
    });

    await h.drain(true);
    expect(h.paypal.captures).toHaveLength(2);
    expect(h.paypal.captures[1]?.idempotencyKey).toMatch(/-2$/);
    h.keys.invalidate((await h.db.select().from(s.agentKeys))[0]?.id ?? "");
    expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
  });
});

describe("prepaid buyers", () => {
  beforeEach(() => h.reset({ mode: "prepaid", balanceMicros: 2_010_000 }));

  it("dropping below the floor tops up from the saved wallet; charges collect at the top-up fee rate", async () => {
    const client = await agent();
    expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200); // $2.00 left < $2 floor? no: 2.00 = floor
    expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200); // $1.99 < floor → top-up queued
    expect(h.queued.map((j) => j.name)).toContain(JOBS.topUp);
    await h.drain();
    expect(h.paypal.captures[0]).toMatchObject({
      amountMicros: 10_000_000,
      reference: expect.stringMatching(/^top_/),
    });
    const [balance] = await h.db.select().from(s.balances);
    expect(balance?.balanceMicros).toBe(1_990_000 + 10_000_000);

    await h.worker[JOBS.scan]();
    await h.drain();
    expect(await states()).toEqual({ collected: 2 });
    const [st] = await h.db.select().from(s.settlements);
    expect(st).toMatchObject({
      kind: "prepaid",
      capturedMicros: 0,
      processorFeeMicros: Math.floor((20_000 * paypalFee(10_000_000)) / 10_000_000),
    });
  });
});

describe("wallet setup through the API", () => {
  beforeEach(() => h.reset({ mode: "prepaid", balanceMicros: 0 }));

  it("setup → approve → complete activates the new mandate, seals the vault token and tops up", async () => {
    const setup = await api("/wallet/setup", h.buyerKey, {
      body: {
        returnUrl: "http://localhost:3000/wallet/return",
        cancelUrl: "http://localhost:3000/wallet/cancel",
      },
    });
    expect(setup.status).toBe(201);
    expect(setup.json.approveUrl).toContain("approval_session_id");
    const done = await api("/wallet/complete", h.buyerKey, {
      body: { mandateId: setup.json.mandateId },
    });
    expect(done).toMatchObject({
      status: 200,
      json: { mode: "prepaid", payerEmail: "buyer@personal.example.com" },
    });

    const mandates = await h.db.select().from(s.mandates);
    expect(mandates.filter((m) => m.status === "active").map((m) => m.id)).toEqual([
      setup.json.mandateId,
    ]);
    const [secret] = await h.db
      .select()
      .from(s.merchantSecrets)
      .where(eq(s.merchantSecrets.ownerId, String(setup.json.mandateId)));
    expect(secret?.blob).not.toContain("VAULT-FAKE");
    await h.drain();
    expect((await h.db.select().from(s.balances))[0]?.balanceMicros).toBe(10_000_000);
  });
});

describe("merchant webhooks and events", () => {
  beforeEach(() => h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 }));

  it("delivers signed events the merchant can verify, and exposes them for polling", async () => {
    const hook = await api("/seller/webhook", h.sellerKey, {
      method: "PUT",
      body: { url: MERCHANT_HOOK },
    });
    const secret = String(hook.json.secret);
    expect(secret).toMatch(/^whsec_/);
    expect(
      (await api("/seller/webhook", h.sellerKey, { method: "PUT", body: { url: MERCHANT_HOOK } }))
        .json.secret,
    ).toBeUndefined();

    const client = await agent();
    await client.fetch(`${SELLERS}/v1/summarize`, body);
    await h.worker[JOBS.deliverEvents]();
    expect(h.merchantHooks).toHaveLength(1);
    const delivered = h.merchantHooks[0];
    expect(
      await verifyWebhookSignature(
        secret,
        delivered?.headers.get(WEBHOOK_SIGNATURE_HEADER),
        delivered?.body ?? "",
      ),
    ).toBe(true);
    expect(JSON.parse(delivered?.body ?? "{}")).toMatchObject({
      type: "charge.recorded",
      api_version: "2026-10-01",
      data: { amount_micros: "10000" },
    });

    await h.worker[JOBS.deliverEvents]();
    expect(h.merchantHooks).toHaveLength(1); // delivered once

    const page = await h.router(`${API}/events?limit=10`, {
      headers: { authorization: `Bearer ${h.sellerKey}` },
    });
    const events = (await page.json()) as { data: { type: string }[] };
    expect(events.data.map((e) => e.type)).toEqual(["charge.recorded"]);
  });
});

describe("refunds and flags through the API", () => {
  beforeEach(() => h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 }));

  it("refunds net off the tab before capture; buyers can flag; only the owning seller may refund", async () => {
    const client = await agent();
    for (let i = 0; i < 3; i++) await client.fetch(`${SELLERS}/v1/summarize`, body);
    const [c1, c2, c3] = await h.db.select().from(s.charges);

    expect(
      (await api(`/charges/${c1?.id}/refund`, h.seller2Key, { body: { reason: "x" } })).status,
    ).toBe(403);
    expect(
      await api(`/charges/${c1?.id}/refund`, h.sellerKey, { body: { reason: "timeout" } }),
    ).toMatchObject({ status: 200, json: { method: "netted" } });
    expect(
      (await api(`/charges/${c2?.id}/flag`, h.buyerKey, { body: { reason: "garbage output" } }))
        .status,
    ).toBe(200);

    h.setClock(() => new Date(Date.now() + PAST_SMALL_TAB_AGE));
    await h.worker[JOBS.scan]();
    await h.drain();
    expect(h.paypal.captures[0]?.amountMicros).toBe(10_000); // only c3
    expect(
      (await api(`/charges/${c3?.id}/flag`, h.buyerKey, { body: { reason: "late" } })).status,
    ).toBe(409);
  });
});

describe("inbound PayPal webhooks", () => {
  beforeEach(() => h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 }));

  it("stores each event once and applies payout item results", async () => {
    const client = await agent();
    // $2.00: big enough that the seller nets something after PayPal's $0.49 fixed fee.
    for (let i = 0; i < 200; i++) await client.fetch(`${SELLERS}/v1/summarize`, body);
    h.setClock(() => new Date(Date.now() + PAST_SMALL_TAB_AGE));
    await h.worker[JOBS.scan]();
    await h.drain();
    await h.worker[JOBS.payoutRun]({ kind: "weekly" });
    h.queued.length = 0; // don't poll: the webhook will report the result
    const [item] = await h.db.select().from(s.payoutItems);

    const event = {
      id: "WH-1",
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {
        payout_item_id: "PI-9",
        payout_item: { sender_item_id: item?.id },
        payout_item_fee: { value: "0.25" },
      },
    };
    const post = () =>
      h.router(`${API}/webhooks/paypal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(h.queued.filter((j) => j.name === JOBS.paypalWebhook)).toHaveLength(1); // deduplicated
    await h.drain();
    expect(await states()).toEqual({ paid_out: 200 });
    expect((await h.db.select().from(s.payoutItems))[0]).toMatchObject({
      status: "success",
      feeMicros: 250_000,
      paypalItemId: "PI-9",
    });
  });
});
