"use server";

import { flagCharge, LedgerError } from "@tab402/ledger";
import { revalidatePath } from "next/cache";
import { db, requireBuyer } from "@/lib/server";

/** Bad output or a failed call: hold the charge out of the next capture until the seller resolves it. */
export async function flag(chargeId: string, reason: string) {
  const { buyer } = await requireBuyer("/receipts");
  try {
    await flagCharge(db, chargeId, buyer.id, reason || "flagged by the buyer");
    revalidatePath("/receipts");
    return { ok: true };
  } catch (err) {
    return {
      error:
        err instanceof LedgerError && err.code === "not_flaggable"
          ? "Only charges that haven't been settled yet can be held."
          : "Couldn't flag this charge.",
    };
  }
}
