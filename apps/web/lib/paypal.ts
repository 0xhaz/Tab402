import "server-only";
import { floorToCents } from "@tab402/core";
import { openSecret, parseMasterKey, schema as s } from "@tab402/db";
import { openTopUp, recordTopUp } from "@tab402/ledger";
import { PayPalClient, PayPalWalletFunding } from "@tab402/paypal";
import { eq } from "drizzle-orm";
import { db } from "./server";

const globals = globalThis as unknown as { __tab402PayPal?: PayPalWalletFunding };

export function funding(): PayPalWalletFunding {
  globals.__tab402PayPal ??= new PayPalWalletFunding(
    new PayPalClient({
      clientId: process.env.PAYPAL_CLIENT_ID ?? "",
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
      env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
    }),
  );
  return globals.__tab402PayPal;
}

export const masterKey = () => parseMasterKey(process.env.TAB402_MASTER_KEY ?? "");

/** Charge the saved wallet now and credit the prepaid balance (same ledger path as the worker's job). */
export async function topUpNow(buyerId: string, amountMicros?: number) {
  const req = await openTopUp(
    db,
    buyerId,
    amountMicros === undefined ? undefined : floorToCents(amountMicros).cents,
  );
  const [secret] = req.vaultSecretId
    ? await db.select().from(s.merchantSecrets).where(eq(s.merchantSecrets.id, req.vaultSecretId))
    : [];
  if (!secret) throw new Error("no saved wallet");
  const result = await funding().capture({
    vaultToken: openSecret(masterKey(), secret.ownerId, secret.kind, secret.blob),
    amountMicros: req.amountMicros,
    reference: req.topUpId,
    description: "Tab402 — prepaid balance top-up",
    lines: [{ description: "Prepaid balance", amountMicros: req.amountMicros }],
    idempotencyKey: req.idempotencyKey,
  });
  return recordTopUp(db, req.topUpId, result);
}
