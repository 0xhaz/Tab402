import type { Database } from "@tab402/db";
import { sql } from "drizzle-orm";
import { REVENUE_TOOL_SCHEMAS, type RevenueToolSchema } from "./revenue-schema";

/**
 * Revenue agent tools: read-only questions over one seller's ledger, quotes and spend-guard
 * outcomes. Every query is scoped to `sellerId` by the server — the model never chooses whose data.
 * Days are UTC. Amounts in the results are USD numbers (micro-USD / 1e6) so the model can't mix units.
 */
export interface RevenueTool extends RevenueToolSchema {
  run(db: Database, sellerId: string, args: Record<string, unknown>, now?: Date): Promise<unknown>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const usd = (micros: unknown) => Math.round(Number(micros ?? 0)) / 1e6;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function parseDay(v: unknown, name: string): Date {
  if (typeof v !== "string" || !DAY.test(v)) throw new ToolInputError(`${name} must be YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ToolInputError(`${name} is not a real date`);
  return d;
}

export class ToolInputError extends Error {
  override name = "ToolInputError";
}

type EndpointDay = {
  endpoint: string;
  revenue: string;
  calls: string;
  buyers: string;
  quotes: string;
  quotes_paid: string;
  walked_away: string;
  avg_quote: string | null;
};
type RuleDay = { endpoint: string; rule: string; outcome: string; n: string; amount: string };

async function dayBreakdown(db: Database, sellerId: string, day: Date) {
  const from = day.toISOString();
  const to = new Date(day.getTime() + 86_400_000).toISOString();
  const endpoints = await db.execute<EndpointDay>(sql`
    with c as (
      select endpoint_id, sum(amount_micros) as revenue, count(*) as calls, count(distinct buyer_id) as buyers
      from charges where seller_id = ${sellerId} and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
        and state not in ('refunded', 'written_off')
      group by endpoint_id),
    q as (
      select endpoint_id, count(*) as quotes, count(*) filter (where status = 'paid') as quotes_paid,
             count(*) filter (where status <> 'paid' and expires_at < now()) as walked_away,
             avg(amount_micros) as avg_quote
      from quotes where seller_id = ${sellerId} and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
      group by endpoint_id)
    select e.method || ' ' || e.url as endpoint,
           coalesce(c.revenue, 0)::text as revenue, coalesce(c.calls, 0)::text as calls, coalesce(c.buyers, 0)::text as buyers,
           coalesce(q.quotes, 0)::text as quotes, coalesce(q.quotes_paid, 0)::text as quotes_paid,
           coalesce(q.walked_away, 0)::text as walked_away, round(q.avg_quote)::text as avg_quote
    from endpoints e left join c on c.endpoint_id = e.id left join q on q.endpoint_id = e.id
    where e.seller_id = ${sellerId} and (c.endpoint_id is not null or q.endpoint_id is not null)
    order by coalesce(c.revenue, 0) desc`);
  const guard = await db.execute<RuleDay>(sql`
    select coalesce(e.method || ' ', '') || g.endpoint_url as endpoint, coalesce(g.rule, g.decided_by::text) as rule,
           g.outcome::text as outcome, count(*)::text as n, sum(g.amount_micros)::text as amount
    from guard_decisions g
    left join endpoints e on e.seller_id = g.seller_id and e.url = g.endpoint_url
    where g.seller_id = ${sellerId} and g.outcome <> 'approve'
      and g.created_at >= ${from}::timestamptz and g.created_at < ${to}::timestamptz
    group by 1, 2, 3 order by count(*) desc`);
  const buyers = await db.execute<{ n: string }>(sql`
    select count(distinct buyer_id)::text as n from charges
    where seller_id = ${sellerId} and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz`);
  return {
    day: isoDay(day),
    endpoints: endpoints.map((e) => ({
      endpoint: e.endpoint,
      revenueUsd: usd(e.revenue),
      paidCalls: Number(e.calls),
      buyers: Number(e.buyers),
      quotes: Number(e.quotes),
      conversion: Number(e.quotes) ? Number(e.quotes_paid) / Number(e.quotes) : null,
      walkedAway: Number(e.walked_away),
      avgQuotedPriceUsd: e.avg_quote == null ? null : usd(e.avg_quote),
    })),
    blockedByBuyerGuards: guard.map((g) => ({
      endpoint: g.endpoint,
      rule: g.rule,
      outcome: g.outcome,
      count: Number(g.n),
      amountUsd: usd(g.amount),
    })),
    activeBuyers: Number(buyers[0]?.n ?? 0),
  };
}

const revenueChange: RevenueTool = {
  ...REVENUE_TOOL_SCHEMAS.revenueChange,
  async run(db, sellerId, args) {
    const day = parseDay(args.day, "day");
    const base =
      args.compare_to === undefined
        ? new Date(day.getTime() - 7 * 86_400_000)
        : parseDay(args.compare_to, "compare_to");
    const [a, b] = await Promise.all([
      dayBreakdown(db, sellerId, day),
      dayBreakdown(db, sellerId, base),
    ]);
    const total = (x: typeof a) => x.endpoints.reduce((s, e) => s + e.revenueUsd, 0);
    const names = new Set([...a.endpoints, ...b.endpoints].map((e) => e.endpoint));
    const drivers = [...names]
      .map((endpoint) => {
        const now = a.endpoints.find((e) => e.endpoint === endpoint);
        const was = b.endpoints.find((e) => e.endpoint === endpoint);
        return {
          endpoint,
          revenueDeltaUsd:
            Math.round(((now?.revenueUsd ?? 0) - (was?.revenueUsd ?? 0)) * 1e6) / 1e6,
          paidCallsDelta: (now?.paidCalls ?? 0) - (was?.paidCalls ?? 0),
          quotesDelta: (now?.quotes ?? 0) - (was?.quotes ?? 0),
        };
      })
      .sort((x, y) => Math.abs(y.revenueDeltaUsd) - Math.abs(x.revenueDeltaUsd));
    return {
      day: a,
      baseline: b,
      totals: {
        revenueUsd: Math.round(total(a) * 1e6) / 1e6,
        baselineRevenueUsd: Math.round(total(b) * 1e6) / 1e6,
        changePct: total(b) ? Math.round(((total(a) - total(b)) / total(b)) * 1000) / 10 : null,
      },
      drivers,
      note: "Revenue counts paid calls in any money state except refunded or written off. Demand = 402 quotes issued; walked away = quoted but never paid.",
    };
  },
};

const moneyStates: RevenueTool = {
  ...REVENUE_TOOL_SCHEMAS.moneyStates,
  async run(db, sellerId) {
    const [states] = await db.execute<Record<string, string>>(sql`
      select
        coalesce(sum(amount_micros) filter (where state = 'earned' and not held), 0)::text as earned,
        coalesce(sum(amount_micros) filter (where state = 'collected'), 0)::text as collected,
        coalesce(sum(amount_micros) filter (where state = 'paid_out'), 0)::text as paid_out,
        coalesce(sum(amount_micros) filter (where held or state = 'disputed'), 0)::text as held,
        coalesce(sum(amount_micros) filter (where state = 'refunded'), 0)::text as refunded,
        coalesce(sum(amount_micros) filter (where state = 'written_off'), 0)::text as written_off,
        count(*) filter (where held or state = 'disputed')::text as open_disputes
      from charges where seller_id = ${sellerId}`);
    const [last] = await db.execute<{
      at: string;
      amount: string;
      fee: string;
      status: string;
    }>(sql`
      select p.created_at::text as at, i.amount_micros::text as amount, i.fee_micros::text as fee, i.status::text as status
      from payout_items i join payouts p on p.id = i.payout_id
      where i.seller_id = ${sellerId} order by p.created_at desc limit 1`);
    return {
      earnedUsd: usd(states?.earned),
      collectedUsd: usd(states?.collected),
      paidOutUsd: usd(states?.paid_out),
      heldUsd: usd(states?.held),
      refundedUsd: usd(states?.refunded),
      writtenOffUsd: usd(states?.written_off),
      openDisputes: Number(states?.open_disputes ?? 0),
      lastPayout: last
        ? { at: last.at, amountUsd: usd(last.amount), feeUsd: usd(last.fee), status: last.status }
        : null,
    };
  },
};

export const REVENUE_TOOLS: RevenueTool[] = [revenueChange, moneyStates];

export function revenueTool(name: string): RevenueTool | undefined {
  return REVENUE_TOOLS.find((t) => t.name === name);
}
