import { describe, expect, it } from "vitest";
import { evaluateRules, type GuardContext, priceBand } from "../src/rules";

const NOW = new Date("2026-10-20T12:00:00Z");

type Overrides = Partial<Omit<GuardContext, "key" | "policy" | "spend">> & {
  key?: Partial<GuardContext["key"]>;
  policy?: Partial<GuardContext["policy"]>;
  spend?: Partial<GuardContext["spend"]>;
};

function ctx(over: Overrides = {}): GuardContext {
  return {
    now: NOW,
    amountMicros: 10_000,
    sellerId: "sel_a",
    category: "llm",
    sellerKnown: true,
    usualPriceMicros: 10_000,
    ...over,
    key: {
      id: "key_1",
      status: "active",
      expiresAt: null,
      dailyBudgetMicros: null,
      budgetCapMicros: null,
      scope: null,
      parent: null,
      ...over.key,
    },
    policy: {
      dailyBudgetMicros: 10_000_000,
      perCallMaxMicros: 1_000_000,
      approvalThresholdMicros: 2_000_000,
      allowlist: null,
      blocklist: [],
      categories: null,
      version: 1,
      ...over.policy,
    },
    spend: {
      buyerTodayMicros: 0,
      keyTodayMicros: 0,
      familyTodayMicros: 0,
      keyTotalMicros: 0,
      last5MinMicros: 0,
      lastHourMicros: 0,
      ...over.spend,
    },
  };
}

describe("spend guard rule table", () => {
  it("approves a routine purchase on rules alone", () => {
    expect(evaluateRules(ctx())).toEqual({ outcome: "approve", rule: "approve.routine" });
  });

  it.each<[string, Overrides, string]>([
    ["revoked key", { key: { status: "revoked" } }, "deny.key_inactive"],
    [
      "expired sub-budget",
      { key: { expiresAt: new Date(NOW.getTime() - 1) } },
      "deny.key_inactive",
    ],
    [
      "frozen parent",
      { key: { parent: { status: "frozen", dailyBudgetMicros: null } } },
      "deny.key_inactive",
    ],
    ["blocklisted seller", { policy: { blocklist: ["sel_a"] } }, "deny.blocklist"],
    ["seller not on allowlist", { policy: { allowlist: ["sel_b"] } }, "deny.allowlist"],
    ["seller outside sub-budget scope", { key: { scope: { sellers: ["sel_b"] } } }, "deny.scope"],
    [
      "category outside sub-budget scope",
      { key: { scope: { categories: ["search"] } } },
      "deny.scope",
    ],
    ["above per-call max ($1)", { amountMicros: 1_000_001 }, "deny.per_call_max"],
    ["over today's budget", { spend: { buyerTodayMicros: 9_995_000 } }, "deny.daily_budget"],
    [
      "over the agent's daily budget",
      { key: { dailyBudgetMicros: 50_000 }, spend: { keyTodayMicros: 45_000 } },
      "deny.key_daily_budget",
    ],
    [
      "over the parent's daily budget",
      {
        key: { parent: { status: "active", dailyBudgetMicros: 100_000 } },
        spend: { familyTodayMicros: 95_000 },
      },
      "deny.parent_daily_budget",
    ],
    [
      "over the sub-budget cap",
      { key: { budgetCapMicros: 200_000 }, spend: { keyTotalMicros: 195_000 } },
      "deny.sub_budget",
    ],
  ])("denies: %s", (_name, over, rule) => {
    expect(evaluateRules(ctx(over))).toMatchObject({ outcome: "deny", rule });
  });

  it("asks a human above the approval threshold ($2)", () => {
    const r = evaluateRules(
      ctx({ amountMicros: 900_000, policy: { approvalThresholdMicros: 800_000 } }),
    );
    expect(r).toMatchObject({ outcome: "ask", rule: "ask.over_threshold" });
  });

  it("deny beats ask: per-call max is checked first", () => {
    expect(evaluateRules(ctx({ amountMicros: 3_000_000 }))).toMatchObject({
      outcome: "deny",
      rule: "deny.per_call_max",
    });
  });

  it.each<[string, Overrides, string[]]>([
    ["first-time seller", { sellerKnown: false }, ["first_time_seller"]],
    ["no price history at this endpoint", { usualPriceMicros: null }, ["no_price_history"]],
    ["price > 1.5× usual", { amountMicros: 16_000 }, ["price_above_usual"]],
    ["price over $0.50", { amountMicros: 600_000, usualPriceMicros: 600_000 }, ["price_over_50c"]],
    [
      "spend spike (3× the hourly baseline)",
      { spend: { last5MinMicros: 400_000, lastHourMicros: 600_000 } },
      ["spend_spike"],
    ],
    ["category not in policy", { policy: { categories: ["search"] } }, ["category_not_in_policy"]],
  ])("grey zone: %s", (_name, over, reasons) => {
    expect(evaluateRules(ctx(over))).toMatchObject({ outcome: "grey", reasons });
  });

  it("tiny bursts below the spike floor are not spikes", () => {
    expect(
      evaluateRules(ctx({ spend: { last5MinMicros: 200_000, lastHourMicros: 200_000 } })),
    ).toMatchObject({ outcome: "approve" });
  });

  it("price bands are powers of two", () => {
    expect(priceBand(10_000)).toBe(13);
    expect(priceBand(16_383)).toBe(13);
    expect(priceBand(16_384)).toBe(14);
    expect(priceBand(0)).toBe(0);
  });
});
