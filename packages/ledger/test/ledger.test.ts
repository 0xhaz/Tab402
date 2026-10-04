import { generateAgentKeyPair, newId } from "@tab402/core";
import { createDb, schema as s } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  allocateFees,
  buyersNeedingTopUp,
  DEFAULT_LEDGER_CONFIG as cfg,
  dueTabs,
  flagCharge,
  LedgerError,
  openCaptureSettlement,
  openPayoutRun,
  openTopUp,
  recordCaptureResult,
  recordPayoutResults,
  recordTopUp,
  refundCharge,
  resolveFlag,
  retryCaptureSettlement,
  settlePrepaid,
  writeOffSettlement,
} from "../src";

const url = await testDatabase("ledger");
await runMigrations(url);
const { db, close } = createDb(url, { max: 4 });
afterAll(close);

const HOUR = 3600_000;
const NOW = new Date("2026-10-20T12:00:00Z");

async function reset() {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(
      `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
}

/** Buyer with an active mandate and one agent key; sellers with payout receivers. */
async function world(
  opts: { mode?: "prepaid" | "postpaid"; sellers?: number; creditLimit?: number } = {},
) {
  const buyerId = newId("buyer");
  await db.insert(s.buyers).values({ id: buyerId, name: "B", email: "b@example.com" });
  const mandateId = newId("mandate");
  await db.insert(s.mandates).values({
    id: mandateId,
    buyerId,
    rail: "paypal_wallet",
    mode: opts.mode ?? "postpaid",
    status: "active",
    vaultSecretId: "sec_vault",
    creditLimitMicros: opts.creditLimit ?? 10_000_000,
  });
  await db.insert(s.balances).values({ buyerId, balanceMicros: 0 });
  const agentId = newId("agent");
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "A" });
  const keyId = newId("agentKey");
  await db
    .insert(s.agentKeys)
    .values({ id: keyId, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });

  const sellers: { id: string; endpointId: string; channelId: string; seq: number }[] = [];
  for (let i = 0; i < (opts.sellers ?? 1); i++) {
    const id = newId("seller");
    await db
      .insert(s.sellers)
      .values({ id, name: `Seller ${i + 1}`, payoutReceiver: `seller${i + 1}@example.com` });
    const endpointId = newId("endpoint");
    await db.insert(s.endpoints).values({
      id: endpointId,
      sellerId: id,
      method: "POST",
      url: `http://s${i}/v1`,
      pricingMode: "fixed",
      priceMicros: 10_000,
    });
    const channelId = newId("channel");
    await db
      .insert(s.channels)
      .values({ id: channelId, agentKeyId: keyId, sellerId: id, cumulativeAuthorizedMicros: 1e12 });
    sellers.push({ id, endpointId, channelId, seq: 0 });
  }

  /** Insert paid charges directly (the API's settle path is covered by tests/e2e). */
  async function charge(
    sellerIndex: number,
    amountMicros: number,
    at: Date = NOW,
    prepaid = opts.mode === "prepaid",
  ) {
    const seller = sellers[sellerIndex];
    if (!seller) throw new Error("no seller");
    seller.seq++;
    const quoteId = newId("quote");
    await db.insert(s.quotes).values({
      id: quoteId,
      endpointId: seller.endpointId,
      sellerId: seller.id,
      amountMicros,
      pricingMode: "fixed",
      status: "paid",
      expiresAt: at,
    });
    const voucherId = newId("voucher");
    await db.insert(s.vouchers).values({
      id: voucherId,
      channelId: seller.channelId,
      seq: seller.seq,
      cumulativeMicros: amountMicros,
      quoteId,
      expiresAt: at,
      signature: "sig",
    });
    const id = newId("charge");
    await db.insert(s.charges).values({
      id,
      buyerId,
      agentKeyId: keyId,
      sellerId: seller.id,
      endpointId: seller.endpointId,
      quoteId,
      channelId: seller.channelId,
      voucherId,
      amountMicros,
      authorizedMicros: amountMicros,
      prepaid,
      createdAt: at,
    });
    return id;
  }
  return { buyerId, mandateId, keyId, sellers, charge };
}

const captured = (feeMicros = 840_000) => ({
  status: "captured" as const,
  orderId: "ORDER1",
  captureId: "CAP1",
  feeMicros,
});
const declined = { status: "declined" as const, orderId: null, reason: "INSTRUMENT_DECLINED" };
const chargeStates = async () =>
  (await db.select({ state: s.charges.state }).from(s.charges)).map((c) => c.state);
const events = async (type: string) =>
  db.select().from(s.eventsOut).where(eq(s.eventsOut.type, type));

beforeAll(reset);
beforeEach(reset);

describe("allocateFees", () => {
  it("splits the processor fee pro rata and never makes net negative", () => {
    const f = allocateFees([6_000_000, 4_000_000], 840_000, 200);
    expect(f).toEqual([
      { processorFeeMicros: 504_000, platformFeeMicros: 120_000, netMicros: 5_376_000 },
      { processorFeeMicros: 336_000, platformFeeMicros: 80_000, netMicros: 3_584_000 },
    ]);
    const tiny = allocateFees([100], 1_000, 200);
    expect(tiny[0]).toEqual({ processorFeeMicros: 100, platformFeeMicros: 0, netMicros: 0 });
  });
});

describe("dueTabs (rules)", () => {
  it.each([
    ["≥ $10", [[10_000_000, 0]], true],
    ["$5, fresh", [[5_000_000, 0]], false],
    ["$5, first charge 25 h ago", [[5_000_000, 25]], true],
    ["$0.50, 25 h ago — rolls over", [[500_000, 25]], false],
    ["$0.50, 31 days ago", [[500_000, 31 * 24]], true],
  ])("%s", async (_name, rows, due) => {
    const w = await world();
    for (const [amount, hoursAgo] of rows as [number, number][])
      await w.charge(0, amount, new Date(NOW.getTime() - hoursAgo * HOUR));
    expect((await dueTabs(db, cfg, NOW)).map((d) => d.buyerId)).toEqual(due ? [w.buyerId] : []);
  });

  it("captures immediately at the open-tab cap; ignores prepaid and held charges", async () => {
    const w = await world({ creditLimit: 3_000_000 });
    await w.charge(0, 3_000_000);
    expect(await dueTabs(db, cfg, NOW)).toEqual([
      { buyerId: w.buyerId, totalMicros: 3_000_000, reason: "cap" },
    ]);
    const p = await world({ mode: "prepaid" });
    await p.charge(0, 20_000_000);
    const held = await world();
    await flagCharge(db, await held.charge(0, 20_000_000), held.buyerId, "bad output");
    expect((await dueTabs(db, cfg, NOW)).map((d) => d.buyerId)).toEqual([w.buyerId]);
  });
});

describe("capture settlement", () => {
  it("one capture across sellers, whole cents, sub-cent carry, pro-rata fees, events", async () => {
    const w = await world({ sellers: 3 });
    await w.charge(0, 6_000_000);
    await w.charge(1, 3_000_000);
    await w.charge(2, 1_030_579);
    const req = await openCaptureSettlement(db, w.buyerId);
    expect(req).toMatchObject({
      amountMicros: 10_030_000,
      idempotencyKey: `${req?.settlementId}-1`,
      vaultSecretId: "sec_vault",
    });
    expect(req?.lines.reduce((a, l) => a + l.amountMicros, 0)).toBe(10_030_579);
    expect(await openCaptureSettlement(db, w.buyerId)).toBeNull(); // nothing left to reserve

    const settlementId = req?.settlementId ?? "";
    expect(await recordCaptureResult(db, settlementId, captured(), cfg, NOW)).toEqual({
      status: "captured",
      attempts: 1,
    });
    expect(await recordCaptureResult(db, settlementId, captured(), cfg, NOW)).toEqual({
      status: "unchanged",
    });

    const items = await db.select().from(s.settlementItems);
    expect(items.reduce((a, i) => a + i.processorFeeMicros, 0)).toBe(840_000);
    expect(
      items.reduce((a, i) => a + i.netMicros + i.processorFeeMicros + i.platformFeeMicros, 0),
    ).toBe(10_030_579);
    expect(await chargeStates()).toEqual(["collected", "collected", "collected"]);
    const [buyer] = await db.select().from(s.buyers);
    expect(buyer?.carryMicros).toBe(579);
    expect(await events("tab.settled")).toHaveLength(3);

    // The carry rides on the next capture.
    await w.charge(0, 9_999_421);
    const next = await openCaptureSettlement(db, w.buyerId);
    expect(next?.amountMicros).toBe(10_000_000);
  });

  it("charges arriving during a capture wait for the next one", async () => {
    const w = await world();
    await w.charge(0, 10_000_000);
    const req = await openCaptureSettlement(db, w.buyerId);
    await w.charge(0, 50_000);
    await recordCaptureResult(db, req?.settlementId ?? "", captured(), cfg, NOW);
    const states = await db
      .select({ amount: s.charges.amountMicros, state: s.charges.state })
      .from(s.charges);
    expect(states.find((c) => c.amount === 50_000)?.state).toBe("earned");
  });

  it("decline freezes keys and mandate; a successful retry unfreezes; 3 captures raise the cap", async () => {
    const w = await world();
    await w.charge(0, 10_000_000);
    const req = await openCaptureSettlement(db, w.buyerId);
    const id = req?.settlementId ?? "";
    expect(await recordCaptureResult(db, id, declined, cfg, NOW)).toEqual({
      status: "declined",
      attempts: 1,
      final: false,
    });
    expect((await db.select().from(s.agentKeys))[0]?.status).toBe("frozen");
    expect((await db.select().from(s.mandates))[0]?.status).toBe("frozen");
    expect(await events("tab.capture_failed")).toHaveLength(1);

    const retry = await retryCaptureSettlement(db, id);
    expect(retry?.idempotencyKey).toBe(`${id}-2`);
    expect(await recordCaptureResult(db, id, captured(), cfg, NOW)).toEqual({
      status: "captured",
      attempts: 2,
    });
    expect((await db.select().from(s.agentKeys))[0]?.status).toBe("active");
    expect((await db.select().from(s.mandates))[0]).toMatchObject({
      status: "active",
      successfulCaptures: 1,
    });

    for (let i = 0; i < 2; i++) {
      await w.charge(0, 10_000_000);
      const r = await openCaptureSettlement(db, w.buyerId);
      await recordCaptureResult(db, r?.settlementId ?? "", captured(), cfg, NOW);
    }
    expect((await db.select().from(s.mandates))[0]).toMatchObject({
      successfulCaptures: 3,
      creditLimitMicros: 25_000_000,
    });
  });

  it("second decline is final → write-off", async () => {
    const w = await world();
    await w.charge(0, 10_000_000);
    const id = (await openCaptureSettlement(db, w.buyerId))?.settlementId ?? "";
    await recordCaptureResult(db, id, declined, cfg, NOW);
    await retryCaptureSettlement(db, id);
    expect(await recordCaptureResult(db, id, declined, cfg, NOW)).toMatchObject({
      final: true,
      attempts: 2,
    });
    expect(await writeOffSettlement(db, id)).toBe(1);
    expect(await chargeStates()).toEqual(["written_off"]);
  });

  it("pending captures complete later (webhook) exactly once", async () => {
    const w = await world();
    await w.charge(0, 10_000_000);
    const id = (await openCaptureSettlement(db, w.buyerId))?.settlementId ?? "";
    expect(
      await recordCaptureResult(
        db,
        id,
        { status: "pending", orderId: "O", captureId: "C" },
        cfg,
        NOW,
      ),
    ).toEqual({ status: "pending" });
    expect(await chargeStates()).toEqual(["earned"]);
    await recordCaptureResult(db, id, captured(), cfg, NOW);
    expect(await chargeStates()).toEqual(["collected"]);
  });
});

describe("prepaid", () => {
  it("top-up credits once; prepaid charges pass through the top-up fee rate", async () => {
    const w = await world({ mode: "prepaid" });
    expect(await buyersNeedingTopUp(db)).toEqual([w.buyerId]);
    const t1 = await openTopUp(db, w.buyerId);
    expect(t1.amountMicros).toBe(10_000_000);
    expect((await openTopUp(db, w.buyerId)).topUpId).toBe(t1.topUpId); // one in flight
    expect(await buyersNeedingTopUp(db)).toEqual([]);
    expect(await recordTopUp(db, t1.topUpId, captured(840_000))).toBe("captured");
    expect(await recordTopUp(db, t1.topUpId, captured(840_000))).toBe("unchanged");
    expect((await db.select().from(s.balances))[0]?.balanceMicros).toBe(10_000_000);

    await w.charge(0, 1_000_000);
    const id = await settlePrepaid(db, w.buyerId, cfg, NOW);
    const [st] = await db
      .select()
      .from(s.settlements)
      .where(eq(s.settlements.id, id ?? ""));
    expect(st).toMatchObject({
      kind: "prepaid",
      status: "captured",
      grossMicros: 1_000_000,
      processorFeeMicros: 84_000,
      capturedMicros: 0,
    });
    expect(await chargeStates()).toEqual(["collected"]);
    expect(await settlePrepaid(db, w.buyerId, cfg, NOW)).toBeNull();
  });
});

describe("refunds and flags", () => {
  it("nets an uncaptured refund off the tab (prepaid: back to balance)", async () => {
    const w = await world();
    const c1 = await w.charge(0, 4_000_000);
    await w.charge(0, 6_000_000);
    expect(await refundCharge(db, c1, { reason: "bad output" })).toMatchObject({
      method: "netted",
      clawbackMicros: 0,
    });
    expect((await openCaptureSettlement(db, w.buyerId))?.amountMicros).toBe(6_000_000);

    const p = await world({ mode: "prepaid" });
    const pc = await p.charge(0, 25_000);
    await refundCharge(db, pc, { reason: "x" });
    const [bal] = await db.select().from(s.balances).where(eq(s.balances.buyerId, p.buyerId));
    expect(bal?.balanceMicros).toBe(25_000);
  });

  it("after capture: buyer credited, seller clawed back on the next payout", async () => {
    const w = await world();
    const c1 = await w.charge(0, 2_000_000);
    await w.charge(0, 8_000_000);
    const id = (await openCaptureSettlement(db, w.buyerId))?.settlementId ?? "";
    await recordCaptureResult(db, id, captured(), cfg, NOW);
    const [item] = await db
      .select()
      .from(s.settlementItems)
      .where(eq(s.settlementItems.chargeId, c1));
    const r = await refundCharge(db, c1, { sellerId: w.sellers[0]?.id, reason: "duplicate" });
    expect(r).toMatchObject({ method: "balance_credit", clawbackMicros: item?.netMicros });
    expect((await db.select().from(s.balances))[0]?.balanceMicros).toBe(2_000_000);

    const plan = await openPayoutRun(db, "w-test", 0);
    // Payable = net of the remaining charge only (the refunded one is no longer collected) − clawback.
    const items = await db.select().from(s.settlementItems);
    const remainingNet = items
      .filter((i) => i.chargeId !== c1)
      .reduce((a, i) => a + i.netMicros, 0);
    expect(plan?.items[0]?.amountMicros).toBe(
      Math.floor((remainingNet - (item?.netMicros ?? 0)) / 10_000) * 10_000,
    );
  });

  it("refuses refunds of charges inside an in-progress capture, and other sellers' charges", async () => {
    const w = await world({ sellers: 2 });
    const c = await w.charge(0, 10_000_000);
    await openCaptureSettlement(db, w.buyerId);
    await expect(refundCharge(db, c, { reason: "x" })).rejects.toMatchObject({
      code: "in_settlement",
    });
    await expect(
      refundCharge(db, c, { sellerId: w.sellers[1]?.id, reason: "x" }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it("flagged charges are held out of capture until resolved", async () => {
    const w = await world();
    const c = await w.charge(0, 3_000_000);
    await w.charge(0, 8_000_000);
    await flagCharge(db, c, w.buyerId, "garbage response");
    expect(await events("dispute.opened")).toHaveLength(1);
    expect((await openCaptureSettlement(db, w.buyerId))?.amountMicros).toBe(8_000_000);
    await resolveFlag(db, c, w.sellers[0]?.id ?? "", false);
    expect((await openCaptureSettlement(db, w.buyerId))?.amountMicros).toBe(3_000_000);
  });
});

describe("payouts", () => {
  async function settledWorld() {
    const w = await world({ sellers: 2 });
    await w.charge(0, 6_000_000);
    await w.charge(1, 4_000_005);
    const id = (await openCaptureSettlement(db, w.buyerId))?.settlementId ?? "";
    await recordCaptureResult(db, id, captured(), cfg, NOW);
    return w;
  }

  it("one item per seller in whole cents; success → paid_out, carry kept, fee charged next time", async () => {
    const w = await settledWorld();
    const plan = await openPayoutRun(db, "w-2026-10-19", 0);
    expect(plan?.senderBatchId).toBe("t402-w-2026-10-19");
    expect(plan?.items).toHaveLength(2);
    expect(plan?.items.every((i) => i.amountMicros % 10_000 === 0)).toBe(true);
    expect((await openPayoutRun(db, "w-2026-10-19", 0))?.payoutId).toBe(plan?.payoutId); // resume, not re-plan

    const res = await recordPayoutResults(
      db,
      plan?.payoutId ?? "",
      (plan?.items ?? []).map((i) => ({
        itemId: i.itemId,
        providerItemId: `P-${i.itemId}`,
        status: "success" as const,
        feeMicros: 250_000,
      })),
    );
    expect(res.status).toBe("success");
    expect(await chargeStates()).toEqual(["paid_out", "paid_out"]);
    expect(await events("payout.sent")).toHaveLength(2);
    const sellers = await db.select().from(s.sellers);
    expect(sellers.every((x) => x.payoutCarryMicros < 10_000)).toBe(true);

    // Nothing new earned: only the fees are outstanding, so the next run has nothing to pay.
    expect(await openPayoutRun(db, "w-2026-10-26", 0)).toBeNull();
    await w.charge(0, 10_000_000);
    const id2 = (await openCaptureSettlement(db, w.buyerId))?.settlementId ?? "";
    await recordCaptureResult(db, id2, captured(), cfg, NOW);
    const next = await openPayoutRun(db, "w-2026-10-26", 0);
    const net =
      (await db.select().from(s.settlementItems).where(eq(s.settlementItems.settlementId, id2)))[0]
        ?.netMicros ?? 0;
    const carry = sellers.find((x) => x.id === w.sellers[0]?.id)?.payoutCarryMicros ?? 0;
    expect(next?.items[0]?.amountMicros).toBe(
      Math.floor((net + carry - 250_000) / 10_000) * 10_000,
    );
  });

  it("a failed item releases its charges and carry for the next run", async () => {
    await settledWorld();
    const plan = await openPayoutRun(db, "w-fail", 0);
    const [first, second] = plan?.items ?? [];
    const res = await recordPayoutResults(db, plan?.payoutId ?? "", [
      { itemId: first?.itemId ?? "", providerItemId: "P1", status: "success", feeMicros: 0 },
      { itemId: second?.itemId ?? "", providerItemId: "P2", status: "returned", feeMicros: 0 },
    ]);
    expect(res.status).toBe("partial");
    expect(await events("payout.failed")).toHaveLength(1);
    const retry = await openPayoutRun(db, "w-fail-retry", 0);
    expect(retry?.items.map((i) => i.sellerId)).toEqual([second?.sellerId]);
    expect(retry?.items[0]?.amountMicros).toBe(second?.amountMicros);
  });

  it("threshold runs skip sellers below the minimum", async () => {
    await settledWorld();
    expect(await openPayoutRun(db, "d-2026-10-20", cfg.payoutThresholdMicros)).toBeNull();
  });
});
