import type { Database } from "@tab402/db";
import { sql } from "drizzle-orm";
import type { GuardContext, GuardKey, GuardPolicy } from "./rules";

export interface GuardSubject {
  agentKeyId: string;
  buyerId: string;
  sellerId: string;
  endpointId: string;
  amountMicros: number;
}

const DEFAULT_POLICY: GuardPolicy = {
  dailyBudgetMicros: 10_000_000,
  perCallMaxMicros: 1_000_000,
  approvalThresholdMicros: 2_000_000,
  allowlist: null,
  blocklist: [],
  categories: null,
  version: 0,
};

/** What a payment is for, as shown to the model and the approval page. Seller-controlled text. */
export interface GuardSubjectInfo {
  sellerName: string;
  endpointUrl: string;
  description: string | null;
  category: string | null;
  pricing: string;
}

export interface LoadedGuardContext {
  ctx: GuardContext;
  info: GuardSubjectInfo;
  subject: GuardSubject;
  /** Cached decision for this (key, seller, endpoint, price band, policy version), if any. */
  cached: "approve" | "deny" | null;
  /** An approved, unused, unexpired human approval covering this purchase, if any. */
  approvalId: string | null;
}

type Row = {
  quote: { seller_id: string; endpoint_id: string; amount_micros: number } | null;
  key: {
    id: string;
    parent_key_id: string | null;
    status: GuardKey["status"];
    expires_at: string | null;
    daily_budget_micros: number | null;
    budget_cap_micros: number | null;
    scope: GuardKey["scope"];
  } | null;
  family: { id: string; status: GuardKey["status"]; daily_budget_micros: number | null }[];
  policy: {
    daily_budget_micros: number;
    per_call_max_micros: number;
    approval_threshold_micros: number;
    allowlist: string[] | null;
    blocklist: string[];
    categories: string[] | null;
    version: number;
  } | null;
  info: {
    seller_name: string;
    url: string;
    description: string | null;
    category: string | null;
    pricing: string;
  } | null;
  buyer_today: string;
  last5: string;
  last_hour: string;
  key_today: string;
  family_today: string;
  key_total: string;
  seller_known: boolean;
  usual: string | null;
  cached: "approve" | "deny" | "ask" | null;
  approval_id: string | null;
};

/**
 * Everything the guard needs for one (agent key, quote), in ONE statement: the quote, the key and
 * its sub-budget family, the policy, spend aggregates, seller history, usual price, the cached
 * decision and any usable approval. Spend excludes refunded and written-off charges.
 */
export async function loadGuardContext(
  db: Database,
  ref: { agentKeyId: string; buyerId: string; quoteId: string },
  now: Date = new Date(),
): Promise<LoadedGuardContext> {
  // ISO strings: raw sql fragments don't serialize Date objects.
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const five = new Date(now.getTime() - 5 * 60_000).toISOString();
  const hour = new Date(now.getTime() - 3600_000).toISOString();
  const at = now.toISOString();
  const { agentKeyId: keyId, buyerId, quoteId } = ref;
  const counted = sql.raw(`state not in ('refunded', 'written_off')`);

  const rows = await db.execute<Row>(sql`
    with q as (select seller_id, endpoint_id, amount_micros from quotes where id = ${quoteId}),
    k as (select id, parent_key_id, status, expires_at, daily_budget_micros, budget_cap_micros, scope from agent_keys where id = ${keyId}),
    root as (select coalesce(parent_key_id, id) as id from k),
    fam as (select id, parent_key_id, status, daily_budget_micros from agent_keys
            where id = (select id from root) or parent_key_id = (select id from root)),
    pol as (select * from policies where buyer_id = ${buyerId})
    select
      (select row_to_json(q) from q) as quote,
      (select row_to_json(k) from k) as key,
      (select coalesce(json_agg(fam), '[]'::json) from fam) as family,
      (select row_to_json(pol) from pol) as policy,
      (select json_build_object('seller_name', s.name, 'url', e.url, 'description', e.description, 'category', e.category, 'pricing', e.pricing_mode)
         from endpoints e join sellers s on s.id = e.seller_id where e.id = (select endpoint_id from q)) as info,
      (select coalesce(sum(amount_micros), 0)::text from charges where buyer_id = ${buyerId} and created_at >= ${day}::timestamptz and ${counted}) as buyer_today,
      (select coalesce(sum(amount_micros), 0)::text from charges where buyer_id = ${buyerId} and created_at >= ${five}::timestamptz and ${counted}) as last5,
      (select coalesce(sum(amount_micros), 0)::text from charges where buyer_id = ${buyerId} and created_at >= ${hour}::timestamptz and ${counted}) as last_hour,
      (select coalesce(sum(amount_micros), 0)::text from charges
         where agent_key_id in (select id from fam where id = ${keyId} or parent_key_id = ${keyId})
           and created_at >= ${day}::timestamptz and ${counted}) as key_today,
      (select coalesce(sum(amount_micros), 0)::text from charges
         where agent_key_id in (select id from fam) and created_at >= ${day}::timestamptz and ${counted}) as family_today,
      (select coalesce(sum(amount_micros), 0)::text from charges where agent_key_id = ${keyId} and ${counted}) as key_total,
      exists (select 1 from charges where buyer_id = ${buyerId} and seller_id = (select seller_id from q)) as seller_known,
      (select percentile_cont(0.5) within group (order by authorized_micros)::bigint::text
         from (select authorized_micros from charges where buyer_id = ${buyerId} and endpoint_id = (select endpoint_id from q)
               order by created_at desc limit 50) recent) as usual,
      (select outcome from guard_cache
         where agent_key_id = ${keyId} and seller_id = (select seller_id from q) and endpoint_id = (select endpoint_id from q)
           and price_band = floor(log(2, greatest((select amount_micros from q), 1)::numeric))::int
           and policy_version = coalesce((select version from pol), 0)
           and expires_at > ${at}::timestamptz) as cached,
      (select id from approvals
         where agent_key_id = ${keyId} and endpoint_id = (select endpoint_id from q) and status = 'approved'
           and amount_micros >= (select amount_micros from q) and expires_at > ${at}::timestamptz
         order by created_at limit 1) as approval_id`);

  const r = rows[0];
  if (!r?.quote) throw new Error(`unknown quote ${quoteId}`);
  if (!r.key) throw new Error(`unknown agent key ${keyId}`);
  const parentRow = r.key.parent_key_id
    ? r.family.find((f) => f.id === r.key?.parent_key_id)
    : undefined;
  const key: GuardKey = {
    id: r.key.id,
    status: r.key.status,
    expiresAt: r.key.expires_at ? new Date(r.key.expires_at) : null,
    dailyBudgetMicros: r.key.daily_budget_micros,
    budgetCapMicros: r.key.budget_cap_micros,
    scope: r.key.scope ?? null,
    parent: parentRow
      ? { status: parentRow.status, dailyBudgetMicros: parentRow.daily_budget_micros }
      : null,
  };
  const policy: GuardPolicy = r.policy
    ? {
        dailyBudgetMicros: Number(r.policy.daily_budget_micros),
        perCallMaxMicros: Number(r.policy.per_call_max_micros),
        approvalThresholdMicros: Number(r.policy.approval_threshold_micros),
        allowlist: r.policy.allowlist ?? null,
        blocklist: r.policy.blocklist ?? [],
        categories: r.policy.categories ?? null,
        version: r.policy.version,
      }
    : DEFAULT_POLICY;
  const subject: GuardSubject = {
    agentKeyId: keyId,
    buyerId,
    sellerId: r.quote.seller_id,
    endpointId: r.quote.endpoint_id,
    amountMicros: Number(r.quote.amount_micros),
  };
  const info: GuardSubjectInfo = r.info
    ? {
        sellerName: r.info.seller_name,
        endpointUrl: r.info.url,
        description: r.info.description,
        category: r.info.category,
        pricing: r.info.pricing,
      }
    : {
        sellerName: subject.sellerId,
        endpointUrl: "",
        description: null,
        category: null,
        pricing: "fixed",
      };

  return {
    ctx: {
      now,
      amountMicros: subject.amountMicros,
      sellerId: subject.sellerId,
      category: info.category,
      key,
      policy,
      spend: {
        buyerTodayMicros: Number(r.buyer_today),
        keyTodayMicros: Number(r.key_today),
        familyTodayMicros: Number(r.family_today),
        keyTotalMicros: Number(r.key_total),
        last5MinMicros: Number(r.last5),
        lastHourMicros: Number(r.last_hour),
      },
      sellerKnown: r.seller_known,
      usualPriceMicros: r.usual == null ? null : Number(r.usual),
    },
    info,
    subject,
    cached: r.cached === "approve" || r.cached === "deny" ? r.cached : null,
    approvalId: r.approval_id,
  };
}
