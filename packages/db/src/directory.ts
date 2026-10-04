import { formatUsd } from "@tab402/core";
import { and, asc, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "./client";
import * as s from "./schema";

/** One priced endpoint in the Tab402 directory. */
export interface Listing {
  id: string;
  url: string;
  method: string;
  seller: string;
  sellerId: string;
  description: string | null;
  category: string | null;
  pricing: "fixed" | "metered";
  /** Human price, e.g. "$0.01" or "up to $0.05 (metered)". */
  price: string;
  priceMicros: number;
  /** Paid calls in the last 30 days — a popularity signal, never buyer identities. */
  paidCalls30d: number;
}

export interface DirectoryQuery {
  q?: string;
  category?: string;
  sellerId?: string;
  limit?: number;
  offset?: number;
}

const like = (w: string) => `%${w.replace(/[%_\\]/g, "\\$&")}%`;

/**
 * Search the directory: every active endpoint of an active seller. Words match description, URL,
 * category or seller name; results rank by how many words match, then by recent paid calls.
 */
export async function searchDirectory(
  db: Database,
  query: DirectoryQuery = {},
): Promise<Listing[]> {
  const words = (query.q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const hit = (w: string): SQL =>
    or(
      ilike(s.endpoints.description, like(w)),
      ilike(s.endpoints.url, like(w)),
      ilike(s.endpoints.category, like(w)),
      ilike(s.sellers.name, like(w)),
    ) as SQL;
  const score = words.length
    ? sql<number>`(${sql.join(
        words.map((w) => sql`(case when ${hit(w)} then 1 else 0 end)`),
        sql` + `,
      )})`
    : sql<number>`0`;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const calls = sql<string>`(select count(*) from ${s.charges} where ${s.charges.endpointId} = ${s.endpoints.id} and ${s.charges.createdAt} >= ${since}::timestamptz)`;

  const rows = await db
    .select({
      e: s.endpoints,
      seller: s.sellers.name,
      calls: calls.as("calls"),
      score: score.as("score"),
    })
    .from(s.endpoints)
    .innerJoin(s.sellers, eq(s.sellers.id, s.endpoints.sellerId))
    .where(
      and(
        eq(s.endpoints.active, true),
        eq(s.sellers.status, "active"),
        query.category ? eq(s.endpoints.category, query.category) : undefined,
        query.sellerId ? eq(s.endpoints.sellerId, query.sellerId) : undefined,
        words.length ? or(...words.map(hit)) : undefined,
      ),
    )
    .orderBy(desc(sql`score`), desc(sql`calls`), asc(s.sellers.name), asc(s.endpoints.url))
    .limit(Math.min(query.limit ?? 20, 100))
    .offset(query.offset ?? 0);

  return rows.map(({ e, seller, calls }) => ({
    id: e.id,
    url: e.url,
    method: e.method,
    seller,
    sellerId: e.sellerId,
    description: e.description,
    category: e.category,
    pricing: e.pricingMode === "metered" ? "metered" : "fixed",
    price:
      e.pricingMode === "metered"
        ? `up to ${formatUsd(e.priceMicros)} (metered)`
        : formatUsd(e.priceMicros),
    priceMicros: e.priceMicros,
    paidCalls30d: Number(calls),
  }));
}

/** Categories in use, with how many endpoints each has. */
export async function directoryCategories(
  db: Database,
): Promise<{ category: string; endpoints: number }[]> {
  const rows = await db
    .select({ category: s.endpoints.category, n: sql<string>`count(*)` })
    .from(s.endpoints)
    .innerJoin(s.sellers, eq(s.sellers.id, s.endpoints.sellerId))
    .where(and(eq(s.endpoints.active, true), eq(s.sellers.status, "active")))
    .groupBy(s.endpoints.category)
    .orderBy(desc(sql`count(*)`));
  return rows
    .filter((r): r is { category: string; n: string } => r.category != null)
    .map((r) => ({ category: r.category, endpoints: Number(r.n) }));
}

/** An active endpoint by exact URL (origin + path) and method — call_paid only reaches these. */
export async function findEndpoint(
  db: Database,
  url: string,
  method: string,
): Promise<typeof s.endpoints.$inferSelect | null> {
  let normalized: string;
  try {
    const u = new URL(url);
    normalized = `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
  return (
    (await db.query.endpoints.findFirst({
      where: (e, { and, eq }) =>
        and(eq(e.url, normalized), eq(e.method, method.toUpperCase()), eq(e.active, true)),
    })) ?? null
  );
}
