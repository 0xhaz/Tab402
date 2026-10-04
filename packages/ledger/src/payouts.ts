import { floorToCents, formatUsd, newId } from "@tab402/core";
import { type Database, queueNotification, schema as s } from "@tab402/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { recordEvent } from "./events";
import { LedgerError } from "./types";

export interface PayoutPlanItem {
  itemId: string;
  sellerId: string;
  receiver: string;
  amountMicros: number;
}

export interface PayoutPlan {
  payoutId: string;
  senderBatchId: string;
  /** Provider batch id if this run was already submitted (resume after a crash). */
  providerBatchId: string | null;
  items: PayoutPlanItem[];
}

/**
 * Build (or resume) a payout run: one item per seller with payable ≥ `minMicros`, where payable =
 * net of their collected charges + carry − clawbacks, floored to whole cents.
 * `runKey` makes the sender_batch_id stable, so a retried run never pays twice.
 */
export async function openPayoutRun(
  db: Database,
  runKey: string,
  minMicros: number,
): Promise<PayoutPlan | null> {
  const senderBatchId = `t402-${runKey}`;
  const existing = await db.query.payouts.findFirst({
    where: (p, { eq }) => eq(p.senderBatchId, senderBatchId),
  });
  if (existing) {
    const items = await db
      .select({
        itemId: s.payoutItems.id,
        sellerId: s.payoutItems.sellerId,
        receiver: s.sellers.payoutReceiver,
        amountMicros: s.payoutItems.amountMicros,
      })
      .from(s.payoutItems)
      .innerJoin(s.sellers, eq(s.sellers.id, s.payoutItems.sellerId))
      .where(eq(s.payoutItems.payoutId, existing.id));
    return {
      payoutId: existing.id,
      senderBatchId,
      providerBatchId: existing.paypalPayoutBatchId,
      items: items.map((i) => ({ ...i, receiver: i.receiver ?? "" })),
    };
  }

  return db.transaction(async (tx) => {
    const sellers = await tx
      .select()
      .from(s.sellers)
      .where(and(isNotNull(s.sellers.payoutReceiver), eq(s.sellers.status, "active")))
      .for("update");

    const payoutId = newId("payout");
    const plan: PayoutPlanItem[] = [];
    const links: { itemId: string; settlementItemIds: string[]; adjustmentIds: string[] }[] = [];
    const rows: (typeof s.payoutItems.$inferInsert)[] = [];

    for (const seller of sellers) {
      const items = await tx
        .select({ id: s.settlementItems.id, net: s.settlementItems.netMicros })
        .from(s.settlementItems)
        .innerJoin(s.settlements, eq(s.settlements.id, s.settlementItems.settlementId))
        .innerJoin(s.charges, eq(s.charges.id, s.settlementItems.chargeId))
        .where(
          and(
            eq(s.settlementItems.sellerId, seller.id),
            isNull(s.settlementItems.payoutItemId),
            eq(s.settlements.status, "captured"),
            eq(s.charges.state, "collected"),
          ),
        )
        .for("update", { of: s.settlementItems, skipLocked: true });
      const adjustments = await tx
        .select()
        .from(s.sellerAdjustments)
        .where(
          and(
            eq(s.sellerAdjustments.sellerId, seller.id),
            isNull(s.sellerAdjustments.payoutItemId),
          ),
        )
        .for("update", { skipLocked: true });

      const payable =
        items.reduce((a, i) => a + i.net, 0) +
        seller.payoutCarryMicros -
        adjustments.reduce((a, j) => a + j.amountMicros, 0);
      if (payable <= 0 || payable < minMicros) continue;
      const { cents, remainder } = floorToCents(payable);
      if (cents === 0) continue;

      const itemId = newId("payoutItem");
      rows.push({
        id: itemId,
        payoutId,
        sellerId: seller.id,
        amountMicros: cents,
        carryInMicros: seller.payoutCarryMicros,
        carryOutMicros: remainder,
      });
      plan.push({
        itemId,
        sellerId: seller.id,
        receiver: seller.payoutReceiver ?? "",
        amountMicros: cents,
      });
      links.push({
        itemId,
        settlementItemIds: items.map((i) => i.id),
        adjustmentIds: adjustments.map((j) => j.id),
      });
    }
    if (plan.length === 0) return null;

    await tx.insert(s.payouts).values({
      id: payoutId,
      senderBatchId,
      totalMicros: plan.reduce((a, p) => a + p.amountMicros, 0),
    });
    await tx.insert(s.payoutItems).values(rows);
    for (const link of links) {
      if (link.settlementItemIds.length) {
        await tx
          .update(s.settlementItems)
          .set({ payoutItemId: link.itemId })
          .where(inArray(s.settlementItems.id, link.settlementItemIds));
      }
      if (link.adjustmentIds.length) {
        await tx
          .update(s.sellerAdjustments)
          .set({ payoutItemId: link.itemId })
          .where(inArray(s.sellerAdjustments.id, link.adjustmentIds));
      }
    }
    // The carry is in flight with the payout; it comes back on success (remainder) or failure (all).
    await tx
      .update(s.sellers)
      .set({ payoutCarryMicros: 0 })
      .where(
        inArray(
          s.sellers.id,
          plan.map((p) => p.sellerId),
        ),
      );

    return { payoutId, senderBatchId, providerBatchId: null, items: plan };
  });
}

export async function recordPayoutSubmitted(
  db: Database,
  payoutId: string,
  providerBatchId: string,
): Promise<void> {
  await db
    .update(s.payouts)
    .set({ paypalPayoutBatchId: providerBatchId, status: "processing" })
    .where(eq(s.payouts.id, payoutId));
}

export type ProviderItemStatus =
  | "pending"
  | "success"
  | "failed"
  | "unclaimed"
  | "returned"
  | "blocked"
  | "refunded";

export interface ProviderItemResult {
  itemId: string;
  providerItemId: string | null;
  status: ProviderItemStatus;
  feeMicros: number;
}

const FAILED: ProviderItemStatus[] = ["failed", "returned", "blocked", "refunded"];

/**
 * Apply per-item results (from polling or webhooks). Success → charges `paid_out`, carry returned,
 * payout fee charged to the seller's next payout. Failure → everything unlinked so the next
 * run retries. Idempotent per item.
 */
export async function recordPayoutResults(
  db: Database,
  payoutId: string,
  results: ProviderItemResult[],
  now: Date = new Date(),
): Promise<{ status: "processing" | "success" | "failed" | "partial" }> {
  return db.transaction(async (tx) => {
    const [payout] = await tx
      .select()
      .from(s.payouts)
      .where(eq(s.payouts.id, payoutId))
      .for("update");
    if (!payout) throw new LedgerError("not_found", "payout not found");

    for (const r of results) {
      const [item] = await tx
        .select()
        .from(s.payoutItems)
        .where(and(eq(s.payoutItems.id, r.itemId), eq(s.payoutItems.payoutId, payoutId)))
        .for("update");
      if (!item || item.status === "success" || item.status === "failed") continue;

      if (r.status === "success") {
        await tx
          .update(s.payoutItems)
          .set({
            status: "success",
            feeMicros: r.feeMicros,
            paypalItemId: r.providerItemId,
            reconState: "matched",
          })
          .where(eq(s.payoutItems.id, item.id));
        const settled = await tx
          .select({ chargeId: s.settlementItems.chargeId })
          .from(s.settlementItems)
          .where(eq(s.settlementItems.payoutItemId, item.id));
        if (settled.length) {
          await tx
            .update(s.charges)
            .set({ state: "paid_out", stateChangedAt: now })
            .where(
              and(
                inArray(
                  s.charges.id,
                  settled.map((x) => x.chargeId),
                ),
                eq(s.charges.state, "collected"),
              ),
            );
          await tx
            .update(s.settlementItems)
            .set({ reconState: "matched" })
            .where(eq(s.settlementItems.payoutItemId, item.id));
        }
        await tx
          .update(s.sellers)
          .set({ payoutCarryMicros: sql`${s.sellers.payoutCarryMicros} + ${item.carryOutMicros}` })
          .where(eq(s.sellers.id, item.sellerId));
        if (r.feeMicros > 0) {
          await tx.insert(s.sellerAdjustments).values({
            id: newId("adjustment"),
            sellerId: item.sellerId,
            amountMicros: r.feeMicros,
            reason: `payout fee ${payout.senderBatchId}`,
          });
        }
        await queueNotification(
          tx,
          { sellerId: item.sellerId },
          {
            kind: "payout.sent",
            title: `Payout sent: ${formatUsd(item.amountMicros)}`,
            body: "On its way to your PayPal account.",
            url: "/selling",
            tag: `payout-${item.id}`,
          },
        );
        await recordEvent(
          tx,
          item.sellerId,
          "payout.sent",
          {
            payout_id: payoutId,
            payout_item_id: item.id,
            amount_micros: String(item.amountMicros),
            fee_micros: String(r.feeMicros),
            provider_batch_id: payout.paypalPayoutBatchId,
          },
          now,
        );
      } else if (FAILED.includes(r.status)) {
        await tx
          .update(s.payoutItems)
          .set({ status: "failed", paypalItemId: r.providerItemId, reconState: "rejected" })
          .where(eq(s.payoutItems.id, item.id));
        await tx
          .update(s.settlementItems)
          .set({ payoutItemId: null })
          .where(eq(s.settlementItems.payoutItemId, item.id));
        await tx
          .update(s.sellerAdjustments)
          .set({ payoutItemId: null })
          .where(eq(s.sellerAdjustments.payoutItemId, item.id));
        await tx
          .update(s.sellers)
          .set({ payoutCarryMicros: sql`${s.sellers.payoutCarryMicros} + ${item.carryInMicros}` })
          .where(eq(s.sellers.id, item.sellerId));
        await queueNotification(
          tx,
          { sellerId: item.sellerId },
          {
            kind: "payout.failed",
            title: `Payout failed: ${formatUsd(item.amountMicros)}`,
            body: "PayPal rejected it — check your payout receiver. The money stays in your balance.",
            url: "/selling",
            tag: `payout-${item.id}`,
            urgency: "high",
          },
        );
        await recordEvent(
          tx,
          item.sellerId,
          "payout.failed",
          { payout_id: payoutId, payout_item_id: item.id, status: r.status },
          now,
        );
      } else if (r.providerItemId && !item.paypalItemId) {
        await tx
          .update(s.payoutItems)
          .set({ paypalItemId: r.providerItemId, status: "processing" })
          .where(eq(s.payoutItems.id, item.id));
      }
    }

    const items = await tx
      .select({ status: s.payoutItems.status })
      .from(s.payoutItems)
      .where(eq(s.payoutItems.payoutId, payoutId));
    const done = items.filter((i) => i.status === "success" || i.status === "failed");
    const ok = items.filter((i) => i.status === "success").length;
    const status =
      done.length < items.length
        ? "processing"
        : ok === items.length
          ? "success"
          : ok === 0
            ? "failed"
            : "partial";
    await tx.update(s.payouts).set({ status }).where(eq(s.payouts.id, payoutId));
    return { status };
  });
}
