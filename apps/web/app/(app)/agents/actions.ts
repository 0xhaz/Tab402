"use server";

import { schema as s } from "@tab402/db";
import { and, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, requireBuyer } from "@/lib/server";

/** Revoke a key and every sub-budget under it. The facilitator stops accepting it within 30 s. */
export async function revokeKey(keyId: string) {
  const { buyer } = await requireBuyer("/agents");
  await db
    .update(s.agentKeys)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(s.agentKeys.buyerId, buyer.id),
        or(eq(s.agentKeys.id, keyId), eq(s.agentKeys.parentKeyId, keyId)),
      ),
    );
  revalidatePath("/agents");
}
