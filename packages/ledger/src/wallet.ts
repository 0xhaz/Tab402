import { newId } from "@tab402/core";
import { type Database, schema as s, sealSecret } from "@tab402/db";
import { and, eq, ne } from "drizzle-orm";

/** The part of a funding adapter that saves a payment method (structural; PayPal implements it). */
export interface MandateProvider {
  beginMandate(input: {
    returnUrl: string;
    cancelUrl: string;
    description: string;
  }): Promise<{ setupToken: string; approveUrl: string }>;
  completeMandate(
    setupToken: string,
  ): Promise<{ vaultToken: string; payerEmail?: string; customerId?: string }>;
}

/** Step 1 of saving a wallet without a purchase: a pending mandate + PayPal setup token. */
export async function beginWalletMandate(
  db: Database,
  provider: MandateProvider,
  input: { buyerId: string; mode: "prepaid" | "postpaid"; returnUrl: string; cancelUrl: string },
): Promise<{ mandateId: string; setupToken: string; approveUrl: string }> {
  const { setupToken, approveUrl } = await provider.beginMandate({
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
    description: "Tab402 — pay-per-call tab for your AI agents",
  });
  const mandateId = newId("mandate");
  await db.insert(s.mandates).values({
    id: mandateId,
    buyerId: input.buyerId,
    rail: "paypal_wallet",
    mode: input.mode,
    status: "pending",
    setupToken,
  });
  return { mandateId, setupToken, approveUrl };
}

/**
 * Step 2, after the buyer approved at PayPal: exchange the setup token for a vault token, seal it
 * (never leaves the server), and make this the buyer's one active mandate. Identified by the
 * mandate id or by the setup token (what PayPal's JS SDK hands back on approve).
 */
export async function completeWalletMandate(
  db: Database,
  provider: MandateProvider,
  masterKey: Buffer,
  input: { buyerId: string; mandateId?: string; setupToken?: string },
): Promise<{ mandateId: string; mode: "prepaid" | "postpaid"; payerEmail: string | null } | null> {
  const mandate = await db.query.mandates.findFirst({
    where: (m, { and, eq }) =>
      and(
        eq(m.buyerId, input.buyerId),
        eq(m.status, "pending"),
        input.mandateId
          ? eq(m.id, input.mandateId)
          : eq(m.setupToken, input.setupToken ?? "\u0000"),
      ),
  });
  if (!mandate?.setupToken) return null;

  // Claim it first: the JS SDK's onApprove and the redirect fallback can race; only one may
  // exchange the token at PayPal. Clearing setup_token is the claim; it's restored on failure.
  const claimed = await db
    .update(s.mandates)
    .set({ setupToken: null })
    .where(
      and(
        eq(s.mandates.id, mandate.id),
        eq(s.mandates.status, "pending"),
        eq(s.mandates.setupToken, mandate.setupToken),
      ),
    )
    .returning({ id: s.mandates.id });
  if (claimed.length === 0) return null;

  let vaultToken: string;
  let payerEmail: string | undefined;
  try {
    ({ vaultToken, payerEmail } = await provider.completeMandate(mandate.setupToken));
  } catch (err) {
    await db
      .update(s.mandates)
      .set({ setupToken: mandate.setupToken })
      .where(and(eq(s.mandates.id, mandate.id), eq(s.mandates.status, "pending")));
    throw err;
  }
  const secretId = newId("secret");
  await db.transaction(async (tx) => {
    await tx.insert(s.merchantSecrets).values({
      id: secretId,
      ownerId: mandate.id,
      kind: "vault_token",
      blob: sealSecret(masterKey, mandate.id, "vault_token", vaultToken),
    });
    await tx
      .update(s.mandates)
      .set({ status: "revoked" })
      .where(
        and(
          eq(s.mandates.buyerId, input.buyerId),
          eq(s.mandates.status, "active"),
          ne(s.mandates.id, mandate.id),
        ),
      );
    await tx
      .update(s.mandates)
      .set({
        status: "active",
        vaultSecretId: secretId,
        setupToken: null,
        payerEmail: payerEmail ?? null,
      })
      .where(eq(s.mandates.id, mandate.id));
    if (mandate.mode === "prepaid")
      await tx.insert(s.balances).values({ buyerId: input.buyerId }).onConflictDoNothing();
  });
  return { mandateId: mandate.id, mode: mandate.mode, payerEmail: payerEmail ?? null };
}
