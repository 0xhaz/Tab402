import { floorToCents, newId } from "@tab402/core";
import { type Database, queueNotification, schema as s } from "@tab402/db";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { LedgerConfig } from "./config";
import { recordEvent } from "./events";
import { allocateFees } from "./fees";
import { LedgerError, type Tx } from "./types";

/** Charges that can go into a new settlement: earned, not held, not already in one. */
function unsettled(buyerId: string, prepaid: boolean) {
  return and(
    eq(s.charges.buyerId, buyerId),
    eq(s.charges.state, "earned"),
    eq(s.charges.prepaid, prepaid),
    eq(s.charges.held, false),
    isNull(s.settlementItems.id),
  );
}

export interface DueTab {
  buyerId: string;
  totalMicros: number;
  reason: "threshold" | "cap" | "age";
}

/**
 * Post-paid tabs due for capture: ≥ $10, at the open-tab cap, or 24 h after the
 * first unsettled charge — except tabs under $1, which roll over until $10 or 30 days.
 */
export async function dueTabs(
  db: Database,
  cfg: LedgerConfig,
  now: Date = new Date(),
): Promise<DueTab[]> {
  const rows = await db
    .select({
      buyerId: s.charges.buyerId,
      total: sql<string>`sum(${s.charges.amountMicros})::text`,
      oldest: sql<Date>`min(${s.charges.createdAt})`,
      cap: s.mandates.creditLimitMicros,
    })
    .from(s.charges)
    .innerJoin(
      s.mandates,
      and(
        eq(s.mandates.buyerId, s.charges.buyerId),
        eq(s.mandates.status, "active"),
        eq(s.mandates.mode, "postpaid"),
      ),
    )
    .leftJoin(s.settlementItems, eq(s.settlementItems.chargeId, s.charges.id))
    .where(
      and(
        eq(s.charges.state, "earned"),
        eq(s.charges.prepaid, false),
        eq(s.charges.held, false),
        isNull(s.settlementItems.id),
      ),
    )
    .groupBy(s.charges.buyerId, s.mandates.creditLimitMicros);

  const due: DueTab[] = [];
  for (const r of rows) {
    const total = Number(r.total);
    const age = now.getTime() - new Date(r.oldest).getTime();
    if (total >= cfg.settleThresholdMicros)
      due.push({ buyerId: r.buyerId, totalMicros: total, reason: "threshold" });
    else if (total >= r.cap) due.push({ buyerId: r.buyerId, totalMicros: total, reason: "cap" });
    else if (
      age >= cfg.settleAfterMs &&
      (total >= cfg.smallTabMicros || age >= cfg.smallTabMaxAgeMs)
    ) {
      due.push({ buyerId: r.buyerId, totalMicros: total, reason: "age" });
    }
  }
  return due;
}

export interface CaptureRequest {
  settlementId: string;
  buyerId: string;
  mandateId: string;
  vaultSecretId: string | null;
  /** Whole cents to charge. */
  amountMicros: number;
  /** Idempotency key for the provider; changes per attempt. */
  idempotencyKey: string;
  lines: { description: string; amountMicros: number }[];
}

async function receiptLines(tx: Tx, settlementId: string) {
  const rows = await tx
    .select({
      seller: s.sellers.name,
      count: sql<number>`count(*)::int`,
      total: sql<string>`sum(${s.settlementItems.grossMicros})::text`,
    })
    .from(s.settlementItems)
    .innerJoin(s.sellers, eq(s.sellers.id, s.settlementItems.sellerId))
    .where(eq(s.settlementItems.settlementId, settlementId))
    .groupBy(s.sellers.name);
  return rows.map((r) => ({
    description: `${r.seller} — ${r.count} paid calls`,
    amountMicros: Number(r.total),
  }));
}

/**
 * Reserve a buyer's unsettled post-paid charges (across all sellers) in a new pending settlement.
 * The capture is whole cents; the sub-cent remainder carries to the next capture.
 * Returns null when there is nothing (or less than a cent) to capture.
 */
export async function openCaptureSettlement(
  db: Database,
  buyerId: string,
): Promise<CaptureRequest | null> {
  return db.transaction(async (tx) => {
    const [mandate] = await tx
      .select()
      .from(s.mandates)
      .where(
        and(
          eq(s.mandates.buyerId, buyerId),
          eq(s.mandates.status, "active"),
          eq(s.mandates.mode, "postpaid"),
        ),
      )
      .limit(1)
      .for("update");
    if (!mandate) return null;

    const charges = await tx
      .select({ id: s.charges.id, sellerId: s.charges.sellerId, amount: s.charges.amountMicros })
      .from(s.charges)
      .leftJoin(s.settlementItems, eq(s.settlementItems.chargeId, s.charges.id))
      .where(unsettled(buyerId, false))
      .for("update", { of: s.charges, skipLocked: true });
    if (charges.length === 0) return null;

    const [buyer] = await tx.select().from(s.buyers).where(eq(s.buyers.id, buyerId)).for("update");
    const gross = charges.reduce((a, c) => a + c.amount, 0);
    const carryIn = buyer?.carryMicros ?? 0;
    const { cents, remainder } = floorToCents(gross + carryIn);
    if (cents === 0) return null;

    const settlementId = newId("settlement");
    await tx.insert(s.settlements).values({
      id: settlementId,
      buyerId,
      mandateId: mandate.id,
      rail: mandate.rail,
      kind: "capture",
      grossMicros: gross,
      carryInMicros: carryIn,
      carryOutMicros: remainder,
      capturedMicros: cents,
    });
    await tx.insert(s.settlementItems).values(
      charges.map((c) => ({
        id: newId("settlementItem"),
        settlementId,
        chargeId: c.id,
        sellerId: c.sellerId,
        grossMicros: c.amount,
        processorFeeMicros: 0,
        platformFeeMicros: 0,
        netMicros: 0,
      })),
    );

    return {
      settlementId,
      buyerId,
      mandateId: mandate.id,
      vaultSecretId: mandate.vaultSecretId,
      amountMicros: cents,
      idempotencyKey: `${settlementId}-1`,
      lines: await receiptLines(tx, settlementId),
    };
  });
}

/** Re-open a failed settlement for its retry attempt (same charges, new idempotency key). */
export async function retryCaptureSettlement(
  db: Database,
  settlementId: string,
): Promise<CaptureRequest | null> {
  return db.transaction(async (tx) => {
    const [st] = await tx
      .select()
      .from(s.settlements)
      .where(eq(s.settlements.id, settlementId))
      .for("update");
    if (st?.status !== "failed") return null;
    const [mandate] = await tx.select().from(s.mandates).where(eq(s.mandates.id, st.mandateId));
    if (!mandate || mandate.status === "revoked") return null;
    await tx
      .update(s.settlements)
      .set({ status: "pending" })
      .where(eq(s.settlements.id, settlementId));
    return {
      settlementId,
      buyerId: st.buyerId,
      mandateId: st.mandateId,
      vaultSecretId: mandate.vaultSecretId,
      amountMicros: st.capturedMicros,
      idempotencyKey: `${settlementId}-${st.attempts + 1}`,
      lines: await receiptLines(tx, settlementId),
    };
  });
}

export type CaptureOutcome =
  | { status: "captured"; orderId: string; captureId: string | null; feeMicros: number }
  | { status: "pending"; orderId: string; captureId: string | null }
  | { status: "declined"; orderId: string | null; reason: string };

export interface CaptureRecorded {
  status: "captured" | "pending" | "declined" | "unchanged";
  /** For declines: true when no attempts remain and the settlement should be written off. */
  final?: boolean;
  attempts?: number;
}

async function allocateAndCollect(
  tx: Tx,
  settlementId: string,
  processorFeeMicros: number,
  cfg: LedgerConfig,
  now: Date,
) {
  const items = await tx
    .select()
    .from(s.settlementItems)
    .where(eq(s.settlementItems.settlementId, settlementId));
  const fees = allocateFees(
    items.map((i) => i.grossMicros),
    processorFeeMicros,
    cfg.platformFeeBps,
  );
  for (const [i, item] of items.entries()) {
    const f = fees[i];
    if (!f) continue;
    await tx.update(s.settlementItems).set(f).where(eq(s.settlementItems.id, item.id));
  }
  const ids = items.map((i) => i.chargeId);
  if (ids.length) {
    await tx
      .update(s.charges)
      .set({ state: "collected", stateChangedAt: now })
      .where(and(inArray(s.charges.id, ids), eq(s.charges.state, "earned")));
  }

  const bySeller = new Map<string, { charges: number; gross: number; net: number }>();
  for (const [i, item] of items.entries()) {
    const agg = bySeller.get(item.sellerId) ?? { charges: 0, gross: 0, net: 0 };
    agg.charges++;
    agg.gross += item.grossMicros;
    agg.net += fees[i]?.netMicros ?? 0;
    bySeller.set(item.sellerId, agg);
  }
  return bySeller;
}

/**
 * Apply a provider result to a pending settlement. Idempotent: replays of the same outcome (job
 * retry, webhook after the synchronous response) change nothing.
 */
export async function recordCaptureResult(
  db: Database,
  settlementId: string,
  outcome: CaptureOutcome,
  cfg: LedgerConfig,
  now: Date = new Date(),
): Promise<CaptureRecorded> {
  return db.transaction(async (tx) => {
    const [st] = await tx
      .select()
      .from(s.settlements)
      .where(eq(s.settlements.id, settlementId))
      .for("update");
    if (!st) throw new LedgerError("not_found", "settlement not found");
    if (st.status === "captured" || st.status === "refunded") return { status: "unchanged" };

    if (outcome.status === "pending") {
      await tx
        .update(s.settlements)
        .set({
          status: "pending",
          paypalOrderId: outcome.orderId,
          paypalCaptureId: outcome.captureId,
        })
        .where(eq(s.settlements.id, settlementId));
      return { status: "pending" };
    }

    const attempts = st.attempts + 1;
    if (outcome.status === "declined") {
      if (st.status === "failed") return { status: "unchanged" };
      await tx
        .update(s.settlements)
        .set({
          status: "failed",
          attempts,
          lastError: outcome.reason,
          paypalOrderId: outcome.orderId,
        })
        .where(eq(s.settlements.id, settlementId));
      // Stop serving: freeze the mandate and the buyer's keys until the tab is paid.
      await tx.update(s.mandates).set({ status: "frozen" }).where(eq(s.mandates.id, st.mandateId));
      await tx
        .update(s.agentKeys)
        .set({ status: "frozen" })
        .where(and(eq(s.agentKeys.buyerId, st.buyerId), eq(s.agentKeys.status, "active")));
      const sellers = await tx
        .selectDistinct({ sellerId: s.settlementItems.sellerId })
        .from(s.settlementItems)
        .where(eq(s.settlementItems.settlementId, settlementId));
      // The buyer's agents are paused until this is paid: tell them; tell each seller it's retrying.
      await queueNotification(
        tx,
        { buyerId: st.buyerId },
        {
          kind: "tab.capture_failed",
          title: "PayPal charge failed — agents paused",
          body: "Your agents can't pay for APIs until your tab is paid. Check your PayPal wallet.",
          url: "/wallet",
          tag: `capture-${settlementId}`,
          urgency: "high",
        },
      );
      for (const { sellerId } of sellers) {
        await queueNotification(
          tx,
          { sellerId },
          {
            kind: "tab.capture_failed",
            title: "A buyer's charge failed",
            body: `Attempt ${attempts}: ${outcome.reason}. Tab402 retries automatically; your earnings stay recorded.`,
            url: "/selling",
            tag: `capture-${settlementId}`,
          },
        );
        await recordEvent(
          tx,
          sellerId,
          "tab.capture_failed",
          { settlement_id: settlementId, attempt: attempts, reason: outcome.reason },
          now,
        );
      }
      return { status: "declined", attempts, final: attempts >= cfg.maxCaptureAttempts };
    }

    // Captured.
    await tx
      .update(s.settlements)
      .set({
        status: "captured",
        attempts,
        processorFeeMicros: outcome.feeMicros,
        paypalOrderId: outcome.orderId,
        paypalCaptureId: outcome.captureId,
        capturedAt: now,
        lastError: null,
      })
      .where(eq(s.settlements.id, settlementId));
    const bySeller = await allocateAndCollect(tx, settlementId, outcome.feeMicros, cfg, now);
    await tx
      .update(s.buyers)
      .set({ carryMicros: st.carryOutMicros })
      .where(eq(s.buyers.id, st.buyerId));

    const [mandate] = await tx
      .select()
      .from(s.mandates)
      .where(eq(s.mandates.id, st.mandateId))
      .for("update");
    if (mandate) {
      const successfulCaptures = mandate.successfulCaptures + 1;
      const trusted = successfulCaptures >= cfg.trustedAfterCaptures;
      await tx
        .update(s.mandates)
        .set({
          successfulCaptures,
          status: mandate.status === "frozen" ? "active" : mandate.status,
          creditLimitMicros: trusted
            ? Math.max(mandate.creditLimitMicros, cfg.creditLimitTrustedMicros)
            : mandate.creditLimitMicros,
        })
        .where(eq(s.mandates.id, mandate.id));
      if (mandate.status === "frozen") {
        // A successful retry clears the freeze.
        await tx
          .update(s.agentKeys)
          .set({ status: "active" })
          .where(and(eq(s.agentKeys.buyerId, st.buyerId), eq(s.agentKeys.status, "frozen")));
      }
    }

    for (const [sellerId, agg] of bySeller) {
      await recordEvent(
        tx,
        sellerId,
        "tab.settled",
        {
          settlement_id: settlementId,
          charges: agg.charges,
          gross_micros: String(agg.gross),
          net_micros: String(agg.net),
        },
        now,
      );
    }
    return { status: "captured", attempts };
  });
}

/** After the last failed attempt: the unrecovered charges are a Tab402 loss (hackathon policy). */
export async function writeOffSettlement(
  db: Database,
  settlementId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(s.settlementItems)
      .where(eq(s.settlementItems.settlementId, settlementId));
    const ids = items.map((i) => i.chargeId);
    if (ids.length === 0) return 0;
    const done = await tx
      .update(s.charges)
      .set({ state: "written_off", stateChangedAt: now })
      .where(and(inArray(s.charges.id, ids), eq(s.charges.state, "earned")))
      .returning({ id: s.charges.id });
    await tx
      .update(s.settlementItems)
      .set({ reconState: "written_off" })
      .where(eq(s.settlementItems.settlementId, settlementId));
    return done.length;
  });
}

/** Confirmation from the provider (webhook or reconciliation) that a capture really happened. */
export async function markSettlementMatched(db: Database, settlementId: string): Promise<void> {
  await db
    .update(s.settlementItems)
    .set({ reconState: "matched" })
    .where(
      and(
        eq(s.settlementItems.settlementId, settlementId),
        eq(s.settlementItems.reconState, "pending"),
      ),
    );
}

/**
 * Prepaid buyers already paid via top-ups; this moves their earned charges to `collected` with the
 * top-up processor fees passed through at the buyer's effective top-up fee rate.
 */
export async function settlePrepaid(
  db: Database,
  buyerId: string,
  cfg: LedgerConfig,
  now: Date = new Date(),
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const charges = await tx
      .select({ id: s.charges.id, sellerId: s.charges.sellerId, amount: s.charges.amountMicros })
      .from(s.charges)
      .leftJoin(s.settlementItems, eq(s.settlementItems.chargeId, s.charges.id))
      .where(unsettled(buyerId, true))
      .for("update", { of: s.charges, skipLocked: true });
    if (charges.length === 0) return null;

    const [mandate] = await tx
      .select()
      .from(s.mandates)
      .where(eq(s.mandates.buyerId, buyerId))
      .orderBy(sql`${s.mandates.createdAt} desc`)
      .limit(1);
    if (!mandate) throw new LedgerError("no_mandate", "buyer has no mandate");

    const [rate] = await tx
      .select({
        fees: sql<string>`coalesce(sum(${s.topUps.feeMicros}), 0)::text`,
        amount: sql<string>`coalesce(sum(${s.topUps.amountMicros}), 0)::text`,
      })
      .from(s.topUps)
      .where(and(eq(s.topUps.buyerId, buyerId), eq(s.topUps.status, "captured")));
    const gross = charges.reduce((a, c) => a + c.amount, 0);
    const topped = BigInt(rate?.amount ?? "0");
    const fee = topped === 0n ? 0 : Number((BigInt(gross) * BigInt(rate?.fees ?? "0")) / topped);

    const settlementId = newId("settlement");
    await tx.insert(s.settlements).values({
      id: settlementId,
      buyerId,
      mandateId: mandate.id,
      rail: mandate.rail,
      kind: "prepaid",
      grossMicros: gross,
      capturedMicros: 0,
      processorFeeMicros: fee,
      status: "captured",
      capturedAt: now,
    });
    await tx.insert(s.settlementItems).values(
      charges.map((c) => ({
        id: newId("settlementItem"),
        settlementId,
        chargeId: c.id,
        sellerId: c.sellerId,
        grossMicros: c.amount,
        processorFeeMicros: 0,
        platformFeeMicros: 0,
        netMicros: 0,
        // Money already arrived with the top-up capture.
        reconState: "matched" as const,
      })),
    );
    const bySeller = await allocateAndCollect(tx, settlementId, fee, cfg, now);
    for (const [sellerId, agg] of bySeller) {
      await recordEvent(
        tx,
        sellerId,
        "tab.settled",
        {
          settlement_id: settlementId,
          charges: agg.charges,
          gross_micros: String(agg.gross),
          net_micros: String(agg.net),
          prepaid: true,
        },
        now,
      );
    }
    return settlementId;
  });
}

/** Buyers with prepaid charges waiting to be moved to `collected`. */
export async function buyersWithUnsettledPrepaid(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ buyerId: s.charges.buyerId })
    .from(s.charges)
    .leftJoin(s.settlementItems, eq(s.settlementItems.chargeId, s.charges.id))
    .where(
      and(
        eq(s.charges.state, "earned"),
        eq(s.charges.prepaid, true),
        eq(s.charges.held, false),
        isNull(s.settlementItems.id),
      ),
    );
  return rows.map((r) => r.buyerId);
}

/**
 * Resume a capture that is still pending (job crashed or provider timed out after reserving
 * charges). Same idempotency key as the original attempt, so the provider can't charge twice.
 */
export async function pendingCaptureRequest(
  db: Database,
  buyerId: string,
): Promise<CaptureRequest | null> {
  return db.transaction(async (tx) => {
    const [st] = await tx
      .select()
      .from(s.settlements)
      .where(
        and(
          eq(s.settlements.buyerId, buyerId),
          eq(s.settlements.kind, "capture"),
          eq(s.settlements.status, "pending"),
        ),
      )
      .limit(1);
    if (!st) return null;
    const [mandate] = await tx.select().from(s.mandates).where(eq(s.mandates.id, st.mandateId));
    return {
      settlementId: st.id,
      buyerId,
      mandateId: st.mandateId,
      vaultSecretId: mandate?.vaultSecretId ?? null,
      amountMicros: st.capturedMicros,
      idempotencyKey: `${st.id}-${st.attempts + 1}`,
      lines: await receiptLines(tx, st.id),
    };
  });
}

/** Provider reported a refund or reversal of a capture: its charges become disputed (side state). */
export async function markSettlementDisputed(
  db: Database,
  settlementId: string,
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(s.settlementItems)
      .where(eq(s.settlementItems.settlementId, settlementId));
    const ids = items.map((i) => i.chargeId);
    if (ids.length === 0) return 0;
    const moved = await tx
      .update(s.charges)
      .set({ state: "disputed", stateChangedAt: now })
      .where(and(inArray(s.charges.id, ids), inArray(s.charges.state, ["collected", "paid_out"])))
      .returning({
        id: s.charges.id,
        sellerId: s.charges.sellerId,
        amount: s.charges.amountMicros,
      });
    const bySeller = new Map<string, number>();
    for (const m of moved) bySeller.set(m.sellerId, (bySeller.get(m.sellerId) ?? 0) + m.amount);
    for (const [sellerId, amount] of bySeller) {
      await recordEvent(
        tx,
        sellerId,
        "dispute.opened",
        { settlement_id: settlementId, amount_micros: String(amount), reason },
        now,
      );
    }
    return moved.length;
  });
}

/** Captured settlements whose items still await provider confirmation after `olderThanMs`. */
export async function unreconciledSettlements(
  db: Database,
  olderThanMs: number,
  now: Date = new Date(),
) {
  return db
    .selectDistinct({ id: s.settlements.id, orderId: s.settlements.paypalOrderId })
    .from(s.settlements)
    .innerJoin(s.settlementItems, eq(s.settlementItems.settlementId, s.settlements.id))
    .where(
      and(
        eq(s.settlements.kind, "capture"),
        eq(s.settlements.status, "captured"),
        eq(s.settlementItems.reconState, "pending"),
        lt(s.settlements.capturedAt, new Date(now.getTime() - olderThanMs)),
      ),
    );
}

export async function markSettlementRejected(db: Database, settlementId: string): Promise<void> {
  await db
    .update(s.settlementItems)
    .set({ reconState: "rejected" })
    .where(
      and(
        eq(s.settlementItems.settlementId, settlementId),
        eq(s.settlementItems.reconState, "pending"),
      ),
    );
}
