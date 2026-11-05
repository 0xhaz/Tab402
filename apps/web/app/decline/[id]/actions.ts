"use server";

import { schema as s } from "@tab402/db";
import { decideApproval } from "@tab402/guard";
import { verifyDeclineToken } from "@tab402/notify";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/server";

/** Decline from an email link: no session, the signed token is the proof. */
export async function declineFromEmail(form: FormData) {
  const id = String(form.get("id") ?? "");
  const token = String(form.get("t") ?? "");
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !verifyDeclineToken(secret, id, token)) redirect(`/decline/${id}?done=invalid`);
  const [a] = await db
    .select({ buyerId: s.approvals.buyerId })
    .from(s.approvals)
    .where(eq(s.approvals.id, id));
  if (!a) redirect(`/decline/${id}?done=invalid`);
  const result = await decideApproval({ db }, id, a.buyerId, false);
  redirect(`/decline/${id}?t=${encodeURIComponent(token)}&done=${result}`);
}
