/**
 * Run the real onboarding agent (Claude Sonnet 5.5) on an OpenAPI spec and print the proposals.
 *   npx tsx --env-file=.env scripts/agents/try-onboarding.ts [spec-file-or-url]
 * Defaults to the demo sellers' spec. Writes one ai_decisions row to the dev database.
 */
import { readFile } from "node:fs/promises";
import { ClaudeOnboardingModel, proposePricing } from "@tab402/agents";
import { createDb, schema as s } from "@tab402/db";
import { demoOpenApi } from "@tab402/demo-sellers/app";

const arg = process.argv[2];
const specText = !arg
  ? JSON.stringify(demoOpenApi("http://localhost:4200"))
  : /^https?:\/\//.test(arg)
    ? await (await fetch(arg)).text()
    : await readFile(arg, "utf8");

const { db, close } = createDb(process.env.DATABASE_URL ?? "");
const seller = (await db.select().from(s.sellers).limit(1))[0];
if (!seller) throw new Error("no seller in the dev database — run pnpm db:seed");

const o = await proposePricing(
  { db, model: new ClaudeOnboardingModel() },
  { sellerId: seller.id, specText },
);
const log = await db.query.aiDecisions.findFirst({
  where: (d, { eq }) => eq(d.id, o.aiDecisionId),
});
console.log(`${o.api.title} (${o.api.version}) base ${o.api.baseUrl ?? "—"} · model ${o.model}`);
console.table(
  o.proposals.map((p) => ({
    route: p.key,
    charge: p.charge,
    category: p.category,
    price: `${p.pricing === "metered" ? "≤" : ""}$${(p.priceMicros / 1e6).toFixed(4)}`,
    description: p.description,
    why: p.rationale,
  })),
);
console.log(
  `latency ${log?.latencyMs} ms · tokens ${log?.tokensIn}/${log?.tokensOut} · ≈$${((log?.costUsdMicros ?? 0) / 1e6).toFixed(4)}`,
);
await close();
