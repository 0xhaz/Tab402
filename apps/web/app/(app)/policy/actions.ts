"use server";

import { usdToMicros } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, requireBuyer } from "@/lib/server";

const usd = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return usdToMicros(v.replace(/^\$/, ""));
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 10 or 0.50" });
      return z.NEVER;
    }
  });
const list = z.string().transform((v) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean),
);

const PolicyInput = z.object({
  dailyBudget: usd,
  perCallMax: usd,
  approvalThreshold: usd,
  blocklist: list,
  allowlist: list,
});

/** Only the buyer edits limits — no agent tool or API key can. Bumps the version: cached guard decisions stop applying. */
export async function savePolicy(_prev: unknown, form: FormData) {
  const { buyer } = await requireBuyer("/policy");
  const parsed = PolicyInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the values" };
  const p = parsed.data;
  if (p.perCallMax > p.dailyBudget)
    return { error: "Per-call max can't be above the daily budget" };
  await db.insert(s.policies).values({ buyerId: buyer.id }).onConflictDoNothing();
  await db
    .update(s.policies)
    .set({
      dailyBudgetMicros: p.dailyBudget,
      perCallMaxMicros: p.perCallMax,
      approvalThresholdMicros: p.approvalThreshold,
      blocklist: p.blocklist,
      allowlist: p.allowlist.length ? p.allowlist : null,
      version: sql`${s.policies.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(s.policies.buyerId, buyer.id));
  revalidatePath("/policy");
  return { ok: true };
}
