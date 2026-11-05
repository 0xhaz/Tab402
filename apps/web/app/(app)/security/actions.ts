"use server";

import { schema as s } from "@tab402/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, requireBuyer } from "@/lib/server";

export async function removePasskey(id: string) {
  const { user } = await requireBuyer("/security");
  await db.delete(s.passkey).where(and(eq(s.passkey.id, id), eq(s.passkey.userId, user.id)));
  revalidatePath("/security");
}

const ApprovalEmail = z.email().max(254).nullable();

/** Turn approval emails on (with an address) or off (null). */
export async function saveApprovalEmail(
  address: string | null,
): Promise<{ ok: true } | { error: string }> {
  const { buyer } = await requireBuyer("/security");
  const parsed = ApprovalEmail.safeParse(address?.trim() || null);
  if (!parsed.success) return { error: "That doesn't look like an email address." };
  await db.update(s.buyers).set({ approvalEmail: parsed.data }).where(eq(s.buyers.id, buyer.id));
  revalidatePath("/security");
  return { ok: true };
}
