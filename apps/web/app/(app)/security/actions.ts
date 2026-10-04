"use server";

import { schema as s } from "@tab402/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, requireBuyer } from "@/lib/server";

export async function removePasskey(id: string) {
  const { user } = await requireBuyer("/security");
  await db.delete(s.passkey).where(and(eq(s.passkey.id, id), eq(s.passkey.userId, user.id)));
  revalidatePath("/security");
}
