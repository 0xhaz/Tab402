import { floorToCents, newId } from "@tab402/core";
import { type Database, schema as s } from "@tab402/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { CaptureOutcome } from "./tabs";
import { LedgerError } from "./types";

export interface TopUpRequest {
  topUpId: string;
  buyerId: string;
  vaultSecretId: string | null;
  amountMicros: number;
  idempotencyKey: string;
}

/** Prepaid buyers below their floor with auto top-up on and no top-up already in flight. */
export async function buyersNeedingTopUp(db: Database): Promise<string[]> {
  const rows = await db
    .select({ buyerId: s.balances.buyerId })
    .from(s.balances)
    .innerJoin(
      s.mandates,
      and(
        eq(s.mandates.buyerId, s.balances.buyerId),
        eq(s.mandates.status, "active"),
        eq(s.mandates.mode, "prepaid"),
      ),
    )
    .where(
      and(
        eq(s.balances.autoTopUp, true),
        lt(s.balances.balanceMicros, s.balances.floorMicros),
        sql`not exists (select 1 from ${s.topUps} where ${s.topUps.buyerId} = ${s.balances.buyerId} and ${s.topUps.status} = 'pending')`,
      ),
    );
  return rows.map((r) => r.buyerId);
}

/** Start a top-up (or return the one already pending). Amount defaults to the buyer's top-up size. */
export async function openTopUp(
  db: Database,
  buyerId: string,
  amountMicros?: number,
): Promise<TopUpRequest> {
  return db.transaction(async (tx) => {
    const [mandate] = await tx
      .select()
      .from(s.mandates)
      .where(and(eq(s.mandates.buyerId, buyerId), eq(s.mandates.status, "active")))
      .limit(1)
      .for("update");
    if (!mandate) throw new LedgerError("no_mandate", "buyer has no active mandate");

    const [pending] = await tx
      .select()
      .from(s.topUps)
      .where(and(eq(s.topUps.buyerId, buyerId), eq(s.topUps.status, "pending")))
      .limit(1);
    if (pending) {
      return {
        topUpId: pending.id,
        buyerId,
        vaultSecretId: mandate.vaultSecretId,
        amountMicros: pending.amountMicros,
        idempotencyKey: pending.id,
      };
    }

    const [balance] = await tx.select().from(s.balances).where(eq(s.balances.buyerId, buyerId));
    const { cents } = floorToCents(amountMicros ?? balance?.topUpMicros ?? 10_000_000);
    if (cents === 0) throw new LedgerError("invalid_state", "top-up must be at least one cent");
    const topUpId = newId("topUp");
    await tx
      .insert(s.topUps)
      .values({ id: topUpId, buyerId, mandateId: mandate.id, amountMicros: cents });
    return {
      topUpId,
      buyerId,
      vaultSecretId: mandate.vaultSecretId,
      amountMicros: cents,
      idempotencyKey: topUpId,
    };
  });
}

/** Apply a provider result to a top-up. Captured top-ups credit the prepaid balance exactly once. */
export async function recordTopUp(
  db: Database,
  topUpId: string,
  outcome: CaptureOutcome,
): Promise<"captured" | "pending" | "failed" | "unchanged"> {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(s.topUps).where(eq(s.topUps.id, topUpId)).for("update");
    if (!t) throw new LedgerError("not_found", "top-up not found");
    if (t.status !== "pending") return "unchanged";

    if (outcome.status === "pending") {
      await tx
        .update(s.topUps)
        .set({ paypalOrderId: outcome.orderId, paypalCaptureId: outcome.captureId })
        .where(eq(s.topUps.id, topUpId));
      return "pending";
    }
    if (outcome.status === "declined") {
      await tx
        .update(s.topUps)
        .set({ status: "failed", lastError: outcome.reason, paypalOrderId: outcome.orderId })
        .where(eq(s.topUps.id, topUpId));
      return "failed";
    }
    await tx
      .update(s.topUps)
      .set({
        status: "captured",
        feeMicros: outcome.feeMicros,
        paypalOrderId: outcome.orderId,
        paypalCaptureId: outcome.captureId,
      })
      .where(eq(s.topUps.id, topUpId));
    await tx
      .insert(s.balances)
      .values({ buyerId: t.buyerId, balanceMicros: t.amountMicros })
      .onConflictDoUpdate({
        target: s.balances.buyerId,
        set: {
          balanceMicros: sql`${s.balances.balanceMicros} + ${t.amountMicros}`,
          updatedAt: new Date(),
        },
      });
    return "captured";
  });
}
