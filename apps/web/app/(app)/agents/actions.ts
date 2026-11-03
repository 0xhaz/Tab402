"use server";

import { schema as s } from "@tab402/db";
import { and, eq, inArray, or } from "drizzle-orm";
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

/**
 * Re-admit an MCP-held agent after a revoke. The revoked key stays revoked (audit trail); its
 * private key — and its sub-budget keys' — are destroyed, so the MCP server mints a new key next time.
 */
export async function allowAgain(keyId: string) {
  const { buyer } = await requireBuyer("/agents");
  const keys = await db
    .select({ id: s.agentKeys.id })
    .from(s.agentKeys)
    .where(
      and(
        eq(s.agentKeys.buyerId, buyer.id),
        eq(s.agentKeys.status, "revoked"),
        or(eq(s.agentKeys.id, keyId), eq(s.agentKeys.parentKeyId, keyId)),
      ),
    );
  if (keys.length === 0) return;
  await db.delete(s.merchantSecrets).where(
    and(
      eq(s.merchantSecrets.kind, "agent_private_key"),
      inArray(
        s.merchantSecrets.ownerId,
        keys.map((k) => k.id),
      ),
    ),
  );
  revalidatePath("/agents");
}
