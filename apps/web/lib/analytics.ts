import "server-only";
import { schema as s } from "@tab402/db";
import { desc, eq } from "drizzle-orm";
import { db } from "./server";

const usd = (micros: number) => micros / 1e6;
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const path = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/**
 * Seller analytics tables for AG Studio. Every amount sits in exactly one money
 * state column (earned / collected / paid out) so tiles and stacked charts never blur them.
 */
export async function sellerDataset(sellerId: string) {
  const [charges, quotes, guard, payouts] = await Promise.all([
    db
      .select({ c: s.charges, url: s.endpoints.url, buyer: s.buyers.name, si: s.settlementItems })
      .from(s.charges)
      .innerJoin(s.endpoints, eq(s.endpoints.id, s.charges.endpointId))
      .innerJoin(s.buyers, eq(s.buyers.id, s.charges.buyerId))
      .leftJoin(s.settlementItems, eq(s.settlementItems.chargeId, s.charges.id))
      .where(eq(s.charges.sellerId, sellerId))
      .orderBy(desc(s.charges.createdAt))
      .limit(20_000),
    db
      .select({ q: s.quotes, url: s.endpoints.url })
      .from(s.quotes)
      .innerJoin(s.endpoints, eq(s.endpoints.id, s.quotes.endpointId))
      .where(eq(s.quotes.sellerId, sellerId))
      .orderBy(desc(s.quotes.createdAt))
      .limit(20_000),
    db
      .select()
      .from(s.guardDecisions)
      .where(eq(s.guardDecisions.sellerId, sellerId))
      .orderBy(desc(s.guardDecisions.createdAt))
      .limit(5_000),
    db
      .select({ i: s.payoutItems, p: s.payouts })
      .from(s.payoutItems)
      .innerJoin(s.payouts, eq(s.payouts.id, s.payoutItems.payoutId))
      .where(eq(s.payoutItems.sellerId, sellerId))
      .orderBy(desc(s.payouts.createdAt)),
  ]);
  const now = Date.now();
  const expired = (q: (typeof quotes)[number]["q"]) =>
    q.status === "issued" && q.expiresAt.getTime() < now;

  return {
    charges: charges.map(({ c, url, buyer, si }) => ({
      charge_id: c.id,
      day: day(c.createdAt),
      endpoint: path(url),
      buyer,
      state: c.state.replace("_", " "),
      amount: usd(c.amountMicros),
      earned: c.state === "earned" ? usd(c.amountMicros) : 0,
      collected: c.state === "collected" ? usd(c.amountMicros) : 0,
      paid_out: c.state === "paid_out" ? usd(c.amountMicros) : 0,
      // Settled charges only: what PayPal and Tab402 kept, and what reaches the seller.
      paypal_fee: si ? usd(si.processorFeeMicros) : 0,
      platform_fee: si ? usd(si.platformFeeMicros) : 0,
      net: si ? usd(si.netMicros) : 0,
      calls: 1,
    })),
    quotes: quotes.map(({ q, url }) => ({
      quote_id: q.id,
      day: day(q.createdAt),
      endpoint: path(url),
      outcome: q.status === "paid" ? "paid" : expired(q) ? "walked away" : q.status,
      quotes: 1,
      paid: q.status === "paid" ? 1 : 0,
      price: usd(q.amountMicros),
    })),
    guard: guard
      .filter((g) => g.outcome !== "approve")
      .map((g) => ({
        day: day(g.createdAt),
        outcome: g.outcome,
        reason: g.rule ?? "unknown",
        decided_by: g.decidedBy,
        endpoint: path(g.endpointUrl),
        price: usd(g.amountMicros),
        count: 1,
      })),
    payouts: payouts.map(({ i, p }) => ({
      date: p.createdAt,
      batch: p.paypalPayoutBatchId ?? p.senderBatchId,
      amount: usd(i.amountMicros),
      fee: usd(i.feeMicros),
      status: i.status,
    })),
  };
}

/** Buyer analytics: spend by seller and agent, and what the spend guard did. */
export async function buyerDataset(buyerId: string) {
  const today = day(new Date()).getTime();
  const [charges, guard] = await Promise.all([
    db
      .select({ c: s.charges, seller: s.sellers.name, agent: s.agents.name, url: s.endpoints.url })
      .from(s.charges)
      .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
      .innerJoin(s.endpoints, eq(s.endpoints.id, s.charges.endpointId))
      .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.charges.agentKeyId))
      .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
      .where(eq(s.charges.buyerId, buyerId))
      .orderBy(desc(s.charges.createdAt))
      .limit(20_000),
    db
      .select({ g: s.guardDecisions, agent: s.agents.name })
      .from(s.guardDecisions)
      .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.guardDecisions.agentKeyId))
      .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
      .where(eq(s.agentKeys.buyerId, buyerId))
      .orderBy(desc(s.guardDecisions.createdAt))
      .limit(5_000),
  ]);
  return {
    spend: charges.map(({ c, seller, agent, url }) => ({
      day: day(c.createdAt),
      seller,
      agent,
      endpoint: path(url),
      intent: c.intent ?? "",
      state: c.state.replace("_", " "),
      amount: usd(c.amountMicros),
      today: day(c.createdAt).getTime() === today ? usd(c.amountMicros) : 0,
      calls: 1,
    })),
    checks: guard.map(({ g, agent }) => ({
      day: day(g.createdAt),
      agent,
      outcome: g.outcome,
      decided_by: g.decidedBy,
      rule: g.rule ?? "",
      intent: g.intent ?? "",
      price: usd(g.amountMicros),
      count: 1,
      denied: g.outcome === "deny" ? 1 : 0,
      asked: g.outcome === "ask" ? 1 : 0,
    })),
  };
}

export type SellerDataset = Awaited<ReturnType<typeof sellerDataset>>;
export type BuyerDataset = Awaited<ReturnType<typeof buyerDataset>>;

/** Column lists per table (AG Studio needs fields even when a table has no rows yet). */
export const COLUMNS = {
  charges: [
    "charge_id",
    "day",
    "endpoint",
    "buyer",
    "state",
    "amount",
    "earned",
    "collected",
    "paid_out",
    "paypal_fee",
    "platform_fee",
    "net",
    "calls",
  ],
  quotes: ["quote_id", "day", "endpoint", "outcome", "quotes", "paid", "price"],
  guard: ["day", "outcome", "reason", "decided_by", "endpoint", "price", "count"],
  payouts: ["date", "batch", "amount", "fee", "status"],
  spend: ["day", "seller", "agent", "endpoint", "intent", "state", "amount", "today", "calls"],
  checks: [
    "day",
    "agent",
    "outcome",
    "decided_by",
    "rule",
    "intent",
    "price",
    "count",
    "denied",
    "asked",
  ],
} as const;
