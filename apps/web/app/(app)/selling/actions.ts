"use server";

import { randomBytes } from "node:crypto";
import { newId } from "@tab402/core";
import { generateApiKey, schema as s, sealSecret } from "@tab402/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { masterKey } from "@/lib/paypal";
import { db, requireBuyer, sellerFor } from "@/lib/server";

/** Open a seller account and issue its first API key (shown once). */
export async function becomeSeller(name: string) {
  const { user } = await requireBuyer("/selling");
  if (await sellerFor(user.id)) return { error: "You already sell on Tab402." };
  const sellerId = newId("seller");
  const key = generateApiKey("seller");
  await db.transaction(async (tx) => {
    await tx.insert(s.sellers).values({
      id: sellerId,
      userId: user.id,
      name: name.trim() || user.name,
      payoutReceiver: user.email,
    });
    await tx.insert(s.apiKeys).values({
      id: newId("apiKey"),
      ownerType: "seller",
      ownerId: sellerId,
      prefix: key.prefix,
      hash: key.hash,
    });
  });
  // No revalidate here: re-rendering would unmount the one-time key before the seller copies it.
  return { ok: true, apiKey: key.key };
}

const Settings = z.object({
  payoutReceiver: z.email(),
  webhookUrl: z.union([z.url(), z.literal("")]),
});

export async function saveSellerSettings(_prev: unknown, form: FormData) {
  const { user } = await requireBuyer("/selling");
  const seller = await sellerFor(user.id);
  if (!seller) return { error: "Not a seller" };
  const parsed = Settings.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the values" };
  await db
    .update(s.sellers)
    .set({ payoutReceiver: parsed.data.payoutReceiver, webhookUrl: parsed.data.webhookUrl || null })
    .where(eq(s.sellers.id, seller.id));
  let secret: string | undefined;
  if (parsed.data.webhookUrl) {
    const existing = await db.query.merchantSecrets.findFirst({
      where: (m, { and, eq }) =>
        and(eq(m.ownerId, seller.id), eq(m.kind, "webhook_signing_secret")),
    });
    if (!existing) {
      secret = `whsec_${randomBytes(24).toString("base64url")}`;
      await db.insert(s.merchantSecrets).values({
        id: newId("secret"),
        ownerId: seller.id,
        kind: "webhook_signing_secret",
        blob: sealSecret(masterKey(), seller.id, "webhook_signing_secret", secret),
      });
    }
  }
  revalidatePath("/selling");
  return { ok: true, secret };
}
