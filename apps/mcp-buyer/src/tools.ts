import { inputRequired, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { formatUsd, usdToMicros } from "@tab402/core";
import { findEndpoint, schema as s, searchDirectory } from "@tab402/db";
import { openApproval } from "@tab402/guard";
import { PaymentError, type Receipt, Tab402Client } from "@tab402/sdk-client";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type AgentKeys, DbChannelStore, type HeldKey } from "./agents";
import { callerOf } from "./auth";
import type { McpDeps } from "./context";

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const MAX_BODY_CHARS = 20_000;

const usd = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return usdToMicros(String(v));
  } catch {
    ctx.addIssue({ code: "custom", message: 'amount must be USD like "0.05"' });
    return z.NEVER;
  }
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ ...text(t), isError: true });

/** 2026-07-28 clients send their capabilities with every request; legacy (2025) requests don't. */
function supportsUrlElicitation(ctx: ServerContext): boolean {
  const env = ctx.mcpReq.envelope as
    | Record<string, { elicitation?: { url?: unknown } }>
    | undefined;
  return Boolean(env?.[CLIENT_CAPABILITIES]?.elicitation?.url);
}

/**
 * Ask the human through the client: a URL-mode elicitation to the approval page (— URL mode,
 * never form mode, for payments). The client retries the tool call after the user finishes.
 * Clients without URL elicitation get the link as text and the agent retries.
 */
function needsApproval(
  ctx: ServerContext,
  approval: { id: string; url: string | null },
  what: string,
) {
  const message = `Approve ${what} in Tab402${approval.url ? "" : " (open the Tab402 dashboard → Approvals)"}.`;
  if (approval.url && supportsUrlElicitation(ctx)) {
    return inputRequired({
      inputRequests: { approval: inputRequired.elicitUrl({ message, url: approval.url }) },
      requestState: `apr:${approval.id}`,
    });
  }
  return text(
    `Needs the buyer's approval: ${what}.\n${approval.url ? `Approve here: ${approval.url}\n` : ""}` +
      `Approval id: ${approval.id}. After the buyer approves, call this tool again with the same arguments.`,
  );
}

export function registerTools(server: McpServer, deps: McpDeps, keys: AgentKeys) {
  const db = deps.db;
  const now = () => deps.now?.() ?? new Date();

  async function keyFor(ctx: ServerContext, subBudget?: string): Promise<HeldKey> {
    const caller = callerOf(ctx.http?.authInfo);
    const root = await keys.root(caller.buyerId, caller.agentName);
    if (!subBudget) return root;
    const child = await keys.childOf(root, subBudget);
    if (!child) throw new Error(`unknown sub-budget ${subBudget}`);
    return child;
  }

  /** Re-entry after an approval elicitation: was it approved? */
  async function approvalState(
    ctx: ServerContext,
  ): Promise<"none" | "pending" | "approved" | "declined"> {
    const state = ctx.mcpReq.requestState<string>();
    if (typeof state !== "string" || !state.startsWith("apr:")) return "none";
    const caller = callerOf(ctx.http?.authInfo);
    // requestState comes back through the client: trust nothing but our own record for this buyer.
    const a = await db.query.approvals.findFirst({
      where: (x, { and, eq }) => and(eq(x.id, state.slice(4)), eq(x.buyerId, caller.buyerId)),
    });
    if (!a) return "none";
    if (a.status === "pending") return "pending";
    return a.status === "approved" || a.status === "used" ? "approved" : "declined";
  }

  server.registerTool(
    "search_services",
    {
      title: "Find paid APIs",
      description:
        "Search the Tab402 directory for paid APIs and tools the agent can call with call_paid. Returns URL, method, price and what each does.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What you need, e.g. 'summarize text'"),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const results = await searchDirectory(db, { q: query, limit });
      if (results.length === 0) return text(`No Tab402 services match "${query}".`);
      return json(results.map(({ id: _i, priceMicros: _p, sellerId: _s, ...r }) => r));
    },
  );

  server.registerTool(
    "call_paid",
    {
      title: "Call a paid API",
      description:
        "Call a paid Tab402 endpoint. Payment is handled automatically: the price comes from the seller's quote, the buyer's spend guard checks it against `intent`, and the charge goes on the buyer's tab. " +
        "Purchases above the buyer's approval threshold ask the human first.",
      inputSchema: z.object({
        url: z.url().describe("Endpoint URL from search_services"),
        method: z.string().default("POST"),
        body: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("JSON object or raw string"),
        headers: z.record(z.string(), z.string()).optional(),
        intent: z
          .string()
          .min(3)
          .max(300)
          .describe(
            "One line on what this purchase is for, e.g. 'summarize the Q3 report for the user'",
          ),
        max_price: usd.optional().describe("Refuse if the quote is above this (USD)"),
        sub_budget: z
          .string()
          .optional()
          .describe("Pay from a sub-budget created with create_sub_budget"),
      }),
      annotations: { openWorldHint: true },
    },
    async (args, ctx) => {
      const endpoint = await findEndpoint(db, args.url, args.method);
      if (!endpoint)
        return fail(
          `${args.method} ${args.url} is not a Tab402 endpoint. Use search_services to find one.`,
        );

      if ((await approvalState(ctx)) === "declined")
        return fail("The buyer declined this purchase.");

      const key = await keyFor(ctx, args.sub_budget);
      let receipt: Receipt | undefined;
      const client = new Tab402Client({
        keyId: key.keyId,
        privateKey: key.privateKey,
        store: new DbChannelStore(db, key.keyId),
        fetch: deps.fetch,
        onPayment: (r) => {
          receipt = r;
        },
      });
      const isString = typeof args.body === "string";
      const init: RequestInit = {
        method: args.method.toUpperCase(),
        headers: {
          ...(args.body !== undefined && !isString ? { "content-type": "application/json" } : {}),
          ...args.headers,
        },
        body:
          args.body === undefined
            ? undefined
            : isString
              ? (args.body as string)
              : JSON.stringify(args.body),
      };

      try {
        const res = await client.fetch(args.url, init, {
          intent: args.intent,
          maxPriceMicros: args.max_price,
        });
        const bodyText = await res.text();
        if (receipt) {
          // Keep what the purchase was for on the receipt (routine purchases skip /guard/decide).
          const chargeId = receipt.chargeId;
          await db
            .update(s.charges)
            .set({ intent: args.intent })
            .where(and(eq(s.charges.id, chargeId), eq(s.charges.agentKeyId, key.keyId)));
        }
        return json({
          status: res.status,
          paid: receipt
            ? {
                amount: formatUsd(receipt.chargedMicros),
                charge_id: receipt.chargeId,
                pricing: receipt.quote.pricing,
              }
            : null,
          content_type: res.headers.get("content-type"),
          body:
            bodyText.length > MAX_BODY_CHARS
              ? `${bodyText.slice(0, MAX_BODY_CHARS)}… [truncated]`
              : bodyText,
        });
      } catch (err) {
        if (!(err instanceof PaymentError)) throw err;
        if (err.reason === "approval_required" && err.approval) {
          return needsApproval(
            ctx,
            err.approval,
            `${err.quote ? formatUsd(err.quote.amountMicros) : "this purchase"} for ${args.url} (${args.intent})`,
          );
        }
        const hints: Record<string, string> = {
          guard_denied: "The buyer's spend guard denied it",
          over_max_price: "The quote is above max_price",
          balance_empty: "The buyer's prepaid balance is empty",
          tab_limit:
            "The buyer's open tab is at its limit; it is being settled now — try again shortly",
          no_mandate: "The buyer has no active payment method (or it is frozen)",
          key_inactive: "This agent's key is not active",
        };
        return fail(`${hints[err.reason] ?? `Payment failed (${err.reason})`}: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "create_sub_budget",
    {
      title: "Give a helper agent a smaller budget",
      description:
        "Carve a capped, expiring budget out of this agent's own budget for a helper. Pass the returned id as `sub_budget` to call_paid. It can never exceed what this agent has left.",
      inputSchema: z.object({
        amount: usd.describe("Cap in USD"),
        expires_in_minutes: z.number().int().min(1).max(1440).default(60),
        sellers: z.array(z.string()).optional().describe("Limit to these seller ids"),
        categories: z.array(z.string()).optional().describe("Limit to these categories"),
      }),
    },
    async (args, ctx) => {
      const caller = callerOf(ctx.http?.authInfo);
      const root = await keyFor(ctx);
      const policy = await db.query.policies.findFirst({
        where: (p, { eq }) => eq(p.buyerId, caller.buyerId),
      });
      const dayStart = new Date(
        Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate()),
      );
      const [spent] = await db
        .select({ v: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)::text` })
        .from(s.charges)
        .where(and(eq(s.charges.buyerId, caller.buyerId), gte(s.charges.createdAt, dayStart)));
      const remaining = (policy?.dailyBudgetMicros ?? 10_000_000) - Number(spent?.v ?? 0);
      if (args.amount > remaining)
        return fail(`Only ${formatUsd(Math.max(0, remaining))} of today's budget is left.`);
      const scope =
        args.sellers || args.categories
          ? { sellers: args.sellers, categories: args.categories }
          : null;
      const expiresAt = new Date(now().getTime() + args.expires_in_minutes * 60_000);
      const child = await keys.child(caller.buyerId, root, {
        capMicros: args.amount,
        expiresAt,
        scope,
      });
      return json({
        sub_budget: child.keyId,
        cap: formatUsd(args.amount),
        expires_at: expiresAt.toISOString(),
        scope,
      });
    },
  );

  server.registerTool(
    "get_budget",
    {
      title: "Budget left",
      description:
        "Today's budget, what's been spent, and what's left — for the buyer and for this agent — plus sub-budgets.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const caller = callerOf(ctx.http?.authInfo);
      const root = await keyFor(ctx);
      const dayStart = new Date(
        Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate()),
      );
      const policy = await db.query.policies.findFirst({
        where: (p, { eq }) => eq(p.buyerId, caller.buyerId),
      });
      const counted = sql`${s.charges.state} not in ('refunded', 'written_off')`;
      const [buyer] = await db
        .select({ v: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)::text` })
        .from(s.charges)
        .where(
          and(eq(s.charges.buyerId, caller.buyerId), gte(s.charges.createdAt, dayStart), counted),
        );
      const children = await db
        .select()
        .from(s.agentKeys)
        .where(eq(s.agentKeys.parentKeyId, root.keyId));
      const keyIds = [root.keyId, ...children.map((c) => c.id)];
      const perKey = await db
        .select({
          key: s.charges.agentKeyId,
          today: sql<string>`coalesce(sum(${s.charges.amountMicros}) filter (where ${s.charges.createdAt} >= ${dayStart.toISOString()}::timestamptz), 0)::text`,
          total: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)::text`,
        })
        .from(s.charges)
        .where(and(inArray(s.charges.agentKeyId, keyIds), counted))
        .groupBy(s.charges.agentKeyId);
      const spend = new Map(perKey.map((r) => [r.key, r]));
      const mandate = await db.query.mandates.findFirst({
        where: (m, { and, eq }) =>
          and(eq(m.buyerId, caller.buyerId), or(eq(m.status, "active"), eq(m.status, "frozen"))),
      });
      const balance = await db.query.balances.findFirst({
        where: (b, { eq }) => eq(b.buyerId, caller.buyerId),
      });
      const daily = policy?.dailyBudgetMicros ?? 10_000_000;
      const today = Number(buyer?.v ?? 0);
      return json({
        buyer: {
          daily_budget: formatUsd(daily),
          spent_today: formatUsd(today),
          remaining_today: formatUsd(Math.max(0, daily - today)),
          per_call_max: formatUsd(policy?.perCallMaxMicros ?? 1_000_000),
          approval_threshold: formatUsd(policy?.approvalThresholdMicros ?? 2_000_000),
        },
        agent: {
          name: caller.agentName,
          spent_today: formatUsd(Number(spend.get(root.keyId)?.today ?? 0)),
        },
        funding: mandate
          ? {
              mode: mandate.mode,
              status: mandate.status,
              ...(mandate.mode === "prepaid"
                ? { balance: formatUsd(balance?.balanceMicros ?? 0) }
                : { open_tab_cap: formatUsd(mandate.creditLimitMicros) }),
            }
          : { mode: "none" },
        sub_budgets: children.map((c) => ({
          id: c.id,
          cap: c.budgetCapMicros === null ? null : formatUsd(c.budgetCapMicros),
          spent: formatUsd(Number(spend.get(c.id)?.total ?? 0)),
          expires_at: c.expiresAt?.toISOString() ?? null,
          active: c.status === "active" && (!c.expiresAt || c.expiresAt > now()),
        })),
      });
    },
  );

  server.registerTool(
    "get_tab",
    {
      title: "Open tab",
      description:
        "Charges not yet settled, by seller. Tabs settle through PayPal at $10 or after 24 hours.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const caller = callerOf(ctx.http?.authInfo);
      const rows = await db
        .select({
          seller: s.sellers.name,
          calls: sql<number>`count(*)::int`,
          total: sql<string>`sum(${s.charges.amountMicros})::text`,
        })
        .from(s.charges)
        .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
        .where(and(eq(s.charges.buyerId, caller.buyerId), eq(s.charges.state, "earned")))
        .groupBy(s.sellers.name);
      const total = rows.reduce((a, r) => a + Number(r.total), 0);
      return json({
        open_total: formatUsd(total),
        by_seller: rows.map((r) => ({
          seller: r.seller,
          calls: r.calls,
          amount: formatUsd(Number(r.total)),
        })),
      });
    },
  );

  server.registerTool(
    "list_receipts",
    {
      title: "Receipts",
      description:
        "Itemized charges made by this agent (and its sub-budgets), newest first, with what each was for.",
      inputSchema: z.object({
        period: z.enum(["today", "7d", "30d"]).default("today"),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ period, limit }, ctx) => {
      const root = await keyFor(ctx);
      const from =
        period === "today"
          ? new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate()))
          : new Date(now().getTime() - (period === "7d" ? 7 : 30) * 86_400_000);
      const children = await db
        .select({ id: s.agentKeys.id })
        .from(s.agentKeys)
        .where(eq(s.agentKeys.parentKeyId, root.keyId));
      const rows = await db
        .select({
          id: s.charges.id,
          at: s.charges.createdAt,
          amount: s.charges.amountMicros,
          state: s.charges.state,
          seller: s.sellers.name,
          url: s.endpoints.url,
          intent: sql<
            string | null
          >`coalesce(${s.charges.intent}, (select ${s.guardDecisions.intent} from ${s.guardDecisions} where ${s.guardDecisions.agentKeyId} = ${s.charges.agentKeyId} and ${s.guardDecisions.intent} is not null and ${s.guardDecisions.sellerId} = ${s.charges.sellerId} and ${s.guardDecisions.createdAt} <= ${s.charges.createdAt} order by ${s.guardDecisions.createdAt} desc limit 1))`,
        })
        .from(s.charges)
        .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
        .innerJoin(s.endpoints, eq(s.endpoints.id, s.charges.endpointId))
        .where(
          and(
            inArray(s.charges.agentKeyId, [root.keyId, ...children.map((c) => c.id)]),
            gte(s.charges.createdAt, from),
          ),
        )
        .orderBy(desc(s.charges.createdAt))
        .limit(limit);
      return json(
        rows.map((r) => ({
          charge_id: r.id,
          at: r.at.toISOString(),
          seller: r.seller,
          url: r.url,
          amount: formatUsd(r.amount),
          state: r.state,
          intent: r.intent,
        })),
      );
    },
  );

  server.registerTool(
    "request_approval",
    {
      title: "Ask the human first",
      description:
        "Get the buyer's OK up front for a purchase you know will need it (e.g. above the approval threshold). Then call_paid it within 15 minutes.",
      inputSchema: z.object({
        url: z.url(),
        method: z.string().default("POST"),
        amount: usd.describe("Maximum to approve, in USD"),
        reason: z.string().min(3).max(300).describe("What the purchase is for"),
      }),
    },
    async (args, ctx) => {
      const state = await approvalState(ctx);
      if (state === "approved") return text("Approved. Call call_paid now.");
      if (state === "declined") return fail("The buyer declined.");
      const endpoint = await findEndpoint(db, args.url, args.method);
      if (!endpoint) return fail(`${args.method} ${args.url} is not a Tab402 endpoint.`);
      const caller = callerOf(ctx.http?.authInfo);
      const root = await keyFor(ctx);
      const approval = await openApproval(
        {
          db,
          model: {
            decide: async () => ({ decision: "ask", reasoning: "", model: "none", latencyMs: 0 }),
          },
          approvalBaseUrl: deps.approvalBaseUrl,
        },
        {
          agentKeyId: root.keyId,
          buyerId: caller.buyerId,
          sellerId: endpoint.sellerId,
          endpointId: endpoint.id,
          amountMicros: args.amount,
        },
        args.reason,
        `requested by ${caller.agentName}: ${args.reason}`,
        now(),
      );
      return needsApproval(
        ctx,
        approval,
        `up to ${formatUsd(args.amount)} for ${args.url} (${args.reason})`,
      );
    },
  );
}
