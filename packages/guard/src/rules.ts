/**
 * Spend guard rules. Pure: no I/O, so the facilitator can run them on every
 * payment and tests can cover every row of the rule table.
 *
 *   Deny (code)      key inactive; seller blocked / not allowed / out of sub-budget scope; price above
 *                    per-call max; would exceed a daily budget or sub-budget cap
 *   Ask (human)      amount above the approval threshold
 *   Approve (code)   known seller, price ≤ 1.5× usual and ≤ $0.50, no spend spike
 *   Grey (model)     everything else — first-time seller, unusual price, spike, category mismatch
 */

export interface GuardPolicy {
  dailyBudgetMicros: number;
  perCallMaxMicros: number;
  approvalThresholdMicros: number;
  allowlist: string[] | null;
  blocklist: string[];
  categories: string[] | null;
  version: number;
}

export interface GuardKey {
  id: string;
  status: "active" | "frozen" | "revoked";
  expiresAt: Date | null;
  dailyBudgetMicros: number | null;
  /** Sub-budget keys: total cap and scope. */
  budgetCapMicros: number | null;
  scope: { sellers?: string[]; categories?: string[] } | null;
  parent: { status: "active" | "frozen" | "revoked"; dailyBudgetMicros: number | null } | null;
}

export interface GuardSpend {
  /** Everything the buyer spent today (UTC), all keys. */
  buyerTodayMicros: number;
  /** This key and its sub-budget children, today. */
  keyTodayMicros: number;
  /** Parent key and all its children, today (sub-budget keys only). */
  familyTodayMicros: number;
  /** This key, all time (for sub-budget caps). */
  keyTotalMicros: number;
  last5MinMicros: number;
  lastHourMicros: number;
}

export interface GuardContext {
  now: Date;
  amountMicros: number;
  sellerId: string;
  category: string | null;
  key: GuardKey;
  policy: GuardPolicy;
  spend: GuardSpend;
  /** Buyer has paid this seller before. */
  sellerKnown: boolean;
  /** Median authorized amount of the buyer's recent purchases at this endpoint. */
  usualPriceMicros: number | null;
}

export type GreyReason =
  | "first_time_seller"
  | "no_price_history"
  | "price_above_usual"
  | "price_over_50c"
  | "spend_spike"
  | "category_not_in_policy";

export type RuleResult =
  | { outcome: "deny"; rule: string; message: string }
  | { outcome: "ask"; rule: string; message: string }
  | { outcome: "approve"; rule: string }
  | { outcome: "grey"; rule: string; reasons: GreyReason[] };

export const ROUTINE_MAX_MICROS = 500_000;
export const USUAL_PRICE_FACTOR = 1.5;
export const SPIKE_FACTOR = 3;
/** Below this hourly baseline, a burst isn't treated as a spike (tiny amounts). */
export const SPIKE_FLOOR_MICROS = 100_000;

const usd = (m: number) => `$${(m / 1e6).toFixed(m % 10_000 === 0 ? 2 : 6)}`;

export function evaluateRules(ctx: GuardContext): RuleResult {
  const { key, policy, spend, amountMicros: amount } = ctx;
  const deny = (rule: string, message: string): RuleResult => ({ outcome: "deny", rule, message });

  if (key.status !== "active" || (key.expiresAt && key.expiresAt <= ctx.now))
    return deny("deny.key_inactive", "agent key is not active");
  if (key.parent && key.parent.status !== "active")
    return deny("deny.key_inactive", "parent key is not active");
  if (policy.blocklist.includes(ctx.sellerId))
    return deny("deny.blocklist", "seller is on the blocklist");
  if (policy.allowlist && !policy.allowlist.includes(ctx.sellerId))
    return deny("deny.allowlist", "seller is not on the allowlist");
  if (key.scope?.sellers && !key.scope.sellers.includes(ctx.sellerId))
    return deny("deny.scope", "seller is outside this sub-budget's scope");
  if (key.scope?.categories && !(ctx.category && key.scope.categories.includes(ctx.category))) {
    return deny("deny.scope", "category is outside this sub-budget's scope");
  }
  if (amount > policy.perCallMaxMicros)
    return deny(
      "deny.per_call_max",
      `price ${usd(amount)} is above the per-call max ${usd(policy.perCallMaxMicros)}`,
    );
  if (spend.buyerTodayMicros + amount > policy.dailyBudgetMicros)
    return deny("deny.daily_budget", "would exceed today's budget");
  if (key.dailyBudgetMicros !== null && spend.keyTodayMicros + amount > key.dailyBudgetMicros) {
    return deny("deny.key_daily_budget", "would exceed this agent's daily budget");
  }
  if (
    key.parent?.dailyBudgetMicros != null &&
    spend.familyTodayMicros + amount > key.parent.dailyBudgetMicros
  ) {
    return deny("deny.parent_daily_budget", "would exceed the parent agent's daily budget");
  }
  if (key.budgetCapMicros !== null && spend.keyTotalMicros + amount > key.budgetCapMicros) {
    return deny("deny.sub_budget", "would exceed this sub-budget");
  }

  if (amount > policy.approvalThresholdMicros) {
    return {
      outcome: "ask",
      rule: "ask.over_threshold",
      message: `${usd(amount)} is above the approval threshold ${usd(policy.approvalThresholdMicros)}`,
    };
  }

  const reasons: GreyReason[] = [];
  if (!ctx.sellerKnown) reasons.push("first_time_seller");
  if (ctx.usualPriceMicros === null) reasons.push("no_price_history");
  else if (amount > ctx.usualPriceMicros * USUAL_PRICE_FACTOR) reasons.push("price_above_usual");
  if (amount > ROUTINE_MAX_MICROS) reasons.push("price_over_50c");
  const hourlyBaseline = Math.max(spend.lastHourMicros / 12, SPIKE_FLOOR_MICROS);
  // A spike is a burst already under way (e.g. a looping agent), so only past spend counts.
  if (spend.last5MinMicros > SPIKE_FACTOR * hourlyBaseline) reasons.push("spend_spike");
  if (policy.categories && !(ctx.category && policy.categories.includes(ctx.category)))
    reasons.push("category_not_in_policy");

  if (reasons.length === 0) return { outcome: "approve", rule: "approve.routine" };
  return { outcome: "grey", rule: `grey.${reasons[0]}`, reasons };
}

/** Power-of-two price band for the decision cache. */
export function priceBand(amountMicros: number): number {
  return amountMicros <= 0 ? 0 : Math.floor(Math.log2(amountMicros));
}
