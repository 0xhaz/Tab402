"use server";

import { schema as s } from "@tab402/db";
import { beginWalletMandate, completeWalletMandate } from "@tab402/ledger";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { funding, masterKey, topUpNow } from "@/lib/paypal";
import { db, requireBuyer } from "@/lib/server";

const WEB = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/** createVaultToken for PayPal's save button: a setup token for a new pending mandate. */
export async function startWalletSetup(mode: "prepaid" | "postpaid") {
  const { buyer } = await requireBuyer("/wallet");
  const { setupToken } = await beginWalletMandate(db, funding(), {
    buyerId: buyer.id,
    mode,
    returnUrl: `${WEB}/wallet?paypal=approved`,
    cancelUrl: `${WEB}/wallet?paypal=cancelled`,
  });
  return { vaultSetupToken: setupToken };
}

/** onApprove: exchange the approved setup token for a sealed vault token; prepaid wallets get a first top-up. */
export async function completeWalletSetup(vaultSetupToken: string) {
  const { buyer } = await requireBuyer("/wallet");
  const done = await completeWalletMandate(db, funding(), masterKey(), {
    buyerId: buyer.id,
    setupToken: vaultSetupToken,
  });
  if (!done) return { error: "This PayPal approval doesn't match a pending wallet setup." };
  return finish(buyer.id, done);
}

/**
 * Redirect fallback (phones, home-screen apps): PayPal sent the buyer back to /wallet?paypal=approved
 * but the JS SDK couldn't resume (e.g. the approval finished in another browser context). Complete
 * the buyer's newest pending setup from the server. Safe to race with onApprove: one claim wins.
 */
export async function finishRedirectedSetup() {
  const { buyer } = await requireBuyer("/wallet");
  const pending = await db.query.mandates.findFirst({
    where: (m, { and, eq, gt }) =>
      and(
        eq(m.buyerId, buyer.id),
        eq(m.status, "pending"),
        gt(m.createdAt, new Date(Date.now() - 3600_000)),
      ),
    orderBy: (m, { desc }) => desc(m.createdAt),
  });
  if (!pending) return { done: true as const };
  try {
    const done = await completeWalletMandate(db, funding(), masterKey(), {
      buyerId: buyer.id,
      mandateId: pending.id,
    });
    if (!done) return { done: true as const };
    return finish(buyer.id, done);
  } catch {
    return { error: "PayPal hasn't confirmed the approval. Try saving your wallet again." };
  }
}

async function finish(
  buyerId: string,
  done: { mode: "prepaid" | "postpaid"; payerEmail: string | null },
) {
  let topUp: string | null = null;
  if (done.mode === "prepaid") {
    const balance = await db.query.balances.findFirst({
      where: (b, { eq }) => eq(b.buyerId, buyerId),
    });
    if ((balance?.balanceMicros ?? 0) < (balance?.floorMicros ?? 2_000_000))
      topUp = await topUpNow(buyerId).catch(() => "failed");
  }
  revalidatePath("/wallet");
  revalidatePath("/");
  return { ok: true, payerEmail: done.payerEmail, topUp };
}

export async function topUp() {
  const { buyer } = await requireBuyer("/wallet");
  try {
    const status = await topUpNow(buyer.id);
    revalidatePath("/wallet");
    return status === "captured"
      ? { ok: true }
      : {
          error:
            status === "failed" ? "PayPal declined the top-up." : "Top-up is pending at PayPal.",
        };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Top-up failed" };
  }
}

export async function setAutoTopUp(on: boolean) {
  const { buyer } = await requireBuyer("/wallet");
  await db.update(s.balances).set({ autoTopUp: on }).where(eq(s.balances.buyerId, buyer.id));
  revalidatePath("/wallet");
}
