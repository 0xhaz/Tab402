import { newId } from "@tab402/core";
import { assertTransition, type ChargeState, type Database, schema as s } from "@tab402/db";
import { and, eq, sql } from "drizzle-orm";
import { recordEvent } from "./events";
import { LedgerError, type Tx } from "./types";

async function creditBalance(tx: Tx, buyerId: string, micros: number) {
  await tx
    .insert(s.balances)
    .values({ buyerId, balanceMicros: micros })
    .onConflictDoUpdate({
      target: s.balances.buyerId,
      set: { balanceMicros: sql`${s.balances.balanceMicros} + ${micros}`, updatedAt: new Date() },
    });
}

export interface RefundResult {
  chargeId: string;
  from: ChargeState;
  /** "netted": dropped off the tab before capture (no PayPal refund, no fee). */
  method: "netted" | "balance_credit";
  clawbackMicros: number;
}

/**
 * Refund one charge.
 *  - Not yet captured: netted — it simply leaves the tab (prepaid: amount returns to the balance).
 *  - Captured or paid out: the buyer is credited on their prepaid balance and the seller's net is
 *    clawed back from their next payout. (PayPal refunds of captured money come later.)
 */
export async function refundCharge(
  db: Database,
  chargeId: string,
  opts: { sellerId?: string; reason: string; now?: Date },
): Promise<RefundResult> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [charge] = await tx
      .select()
      .from(s.charges)
      .where(eq(s.charges.id, chargeId))
      .for("update");
    if (!charge) throw new LedgerError("not_found", "charge not found");
    if (opts.sellerId && charge.sellerId !== opts.sellerId)
      throw new LedgerError("forbidden", "charge belongs to another seller");

    const [item] = await tx
      .select()
      .from(s.settlementItems)
      .where(eq(s.settlementItems.chargeId, chargeId));
    let method: RefundResult["method"];
    let clawback = 0;

    if (charge.state === "earned") {
      if (item)
        throw new LedgerError(
          "in_settlement",
          "charge is in a capture that is in progress; retry after it completes",
        );
      method = "netted";
      if (charge.prepaid) await creditBalance(tx, charge.buyerId, charge.amountMicros);
    } else if (
      charge.state === "collected" ||
      charge.state === "paid_out" ||
      charge.state === "disputed"
    ) {
      assertTransition(charge.state, "refunded");
      method = "balance_credit";
      await creditBalance(tx, charge.buyerId, charge.amountMicros);
      clawback = item?.netMicros ?? 0;
      if (clawback > 0) {
        await tx.insert(s.sellerAdjustments).values({
          id: newId("adjustment"),
          sellerId: charge.sellerId,
          chargeId,
          amountMicros: clawback,
          reason: `refund: ${opts.reason}`.slice(0, 200),
        });
      }
      if (item)
        await tx
          .update(s.settlementItems)
          .set({ reconState: "corrected" })
          .where(eq(s.settlementItems.id, item.id));
    } else {
      throw new LedgerError("not_refundable", `a ${charge.state} charge cannot be refunded`);
    }

    await tx
      .update(s.charges)
      .set({ state: "refunded", held: false, stateChangedAt: now })
      .where(and(eq(s.charges.id, chargeId), eq(s.charges.state, charge.state)));
    await recordEvent(
      tx,
      charge.sellerId,
      "charge.refunded",
      {
        charge_id: chargeId,
        amount_micros: String(charge.amountMicros),
        method,
        clawback_micros: String(clawback),
        reason: opts.reason,
      },
      now,
    );
    return { chargeId, from: charge.state, method, clawbackMicros: clawback };
  });
}

/** Buyer flags a charge (failed call, bad output): held out of the next capture until resolved. */
export async function flagCharge(
  db: Database,
  chargeId: string,
  buyerId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [charge] = await tx
      .select()
      .from(s.charges)
      .where(eq(s.charges.id, chargeId))
      .for("update");
    if (!charge || charge.buyerId !== buyerId)
      throw new LedgerError("not_found", "charge not found");
    const [item] = await tx
      .select()
      .from(s.settlementItems)
      .where(eq(s.settlementItems.chargeId, chargeId));
    if (charge.state !== "earned" || item)
      throw new LedgerError("not_flaggable", "only uncaptured charges can be held");
    if (charge.held) return;
    await tx.update(s.charges).set({ held: true }).where(eq(s.charges.id, chargeId));
    await recordEvent(tx, charge.sellerId, "dispute.opened", {
      charge_id: chargeId,
      amount_micros: String(charge.amountMicros),
      reason,
    });
  });
}

/** Seller resolves a flag: refund it, or release it back onto the tab. */
export async function resolveFlag(
  db: Database,
  chargeId: string,
  sellerId: string,
  refund: boolean,
): Promise<void> {
  if (refund) {
    await refundCharge(db, chargeId, { sellerId, reason: "flag resolved in buyer's favour" });
    return;
  }
  const [charge] = await db.select().from(s.charges).where(eq(s.charges.id, chargeId));
  if (!charge || charge.sellerId !== sellerId)
    throw new LedgerError("not_found", "charge not found");
  await db.update(s.charges).set({ held: false }).where(eq(s.charges.id, chargeId));
}
