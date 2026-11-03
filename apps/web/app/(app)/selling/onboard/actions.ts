"use server";

import {
  CATEGORIES,
  ClaudeOnboardingModel,
  confirmPricing,
  discoveryPreview,
  gateSnippet,
  LiveRoutesError,
  MockOnboardingModel,
  type OnboardingModel,
  pricingDocs,
  proposePricing,
  SpecError,
} from "@tab402/agents";
import { TAB_NETWORKS } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, requireBuyer, sellerFor } from "@/lib/server";

/** Each run costs a model call; a seller gets this many per day. */
const RUNS_PER_DAY = 20;

let model: OnboardingModel | undefined;
const onboardingModel = () =>
  (model ??=
    process.env.ANTHROPIC_API_KEY && process.env.ONBOARDING_MODEL !== "mock"
      ? new ClaudeOnboardingModel({ model: process.env.ONBOARDING_MODEL || undefined })
      : new MockOnboardingModel());

async function currentSeller() {
  const { user } = await requireBuyer("/selling/onboard");
  const seller = await sellerFor(user.id);
  if (!seller) throw new Error("Not a seller.");
  return seller;
}

export async function propose(specText: string) {
  const seller = await currentSeller();
  const [used] = await db
    .select({ n: count() })
    .from(s.aiDecisions)
    .where(
      and(
        eq(s.aiDecisions.agentKind, "onboarding"),
        sql`${s.aiDecisions.subjectIds}->>'sellerId' = ${seller.id}`,
        gte(s.aiDecisions.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  if ((used?.n ?? 0) >= RUNS_PER_DAY)
    return { error: `That's ${RUNS_PER_DAY} spec reviews today — try again tomorrow.` };
  try {
    return {
      ok: true as const,
      ...(await proposePricing(
        { db, model: onboardingModel() },
        { sellerId: seller.id, specText },
      )),
    };
  } catch (err) {
    if (err instanceof SpecError) return { error: err.message };
    console.error("onboarding failed", err);
    return { error: "The pricing assistant is unavailable right now. Try again in a minute." };
  }
}

const Confirm = z.object({
  aiDecisionId: z.string().min(1),
  baseUrl: z.url({ protocol: /^https?$/ }),
  routes: z
    .array(
      z.object({
        method: z.enum(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
        path: z.string().startsWith("/").max(300),
        pricing: z.enum(["fixed", "metered"]),
        // Seller's own price; the category range is advice. $0.0001 … $100 per call.
        priceMicros: z.number().int().min(100).max(100_000_000),
        description: z.string().max(200),
        category: z.enum(CATEGORIES),
      }),
    )
    .min(1, "Pick at least one route to charge for.")
    .max(200),
  overwrite: z.boolean().optional(),
});

export async function confirm(input: z.input<typeof Confirm>) {
  const seller = await currentSeller();
  const parsed = Confirm.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { aiDecisionId, baseUrl, routes, overwrite } = parsed.data;
  try {
    await confirmPricing(db, { sellerId: seller.id, aiDecisionId, baseUrl, routes, overwrite });
  } catch (err) {
    if (err instanceof LiveRoutesError)
      return {
        error: err.message,
        conflict: { changes: err.changes, blocking: err.blocking },
      };
    return { error: (err as Error).message };
  }
  revalidatePath("/selling");
  const network = process.env.TAB402_NETWORK === "live" ? TAB_NETWORKS.live : TAB_NETWORKS.sandbox;
  return {
    ok: true as const,
    snippet: gateSnippet(routes),
    manifest: JSON.stringify(
      discoveryPreview({ name: seller.name, baseUrl, network, routes }),
      null,
      2,
    ),
    docs: pricingDocs({ name: seller.name, baseUrl, routes }),
  };
}
