import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schema as s } from "@tab402/db";
import { decide, decideApproval } from "@tab402/guard";
import { and, desc, eq, sql } from "drizzle-orm";
import { agentOrBuyerAuth } from "../agent-auth";
import { apiKeyAuth } from "../auth";
import { type Deps, type Env, guardDeps } from "../context";
import { ErrorSchema } from "../schemas";

const micros = z.string().regex(/^\d+$/);

const DecisionSchema = z
  .object({
    outcome: z.enum(["approve", "deny", "ask"]),
    decidedBy: z.enum(["rule", "cache", "model", "human"]),
    rule: z.string(),
    reason: z.string(),
    decisionId: z.string(),
    approval: z
      .object({
        id: z.string(),
        url: z.string().nullable(),
        expiresAt: z.string(),
        status: z.string(),
      })
      .optional(),
  })
  .openapi("GuardDecision");

const PolicySchema = z
  .object({
    dailyBudget: micros,
    perCallMax: micros,
    approvalThreshold: micros,
    allowlist: z.array(z.string()).nullable(),
    blocklist: z.array(z.string()),
    categories: z.array(z.string()).nullable(),
    version: z.number(),
  })
  .openapi("Policy");

/** Spend guard API: decisions, the buyer's policy, and human approvals. */
export function guardRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env & { Variables: { agentKeyId?: string } }>();
  app.use("/guard/*", agentOrBuyerAuth(deps));
  app.use("/policy", apiKeyAuth(deps.db, ["buyer"]));
  app.use("/approvals", apiKeyAuth(deps.db, ["buyer"]));
  app.use("/approvals/*", apiKeyAuth(deps.db, ["buyer"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/guard/decide",
      tags: ["Spend guard"],
      summary: "Check a quote against the buyer's policy before paying",
      description:
        'Deterministic rules first; grey-zone purchases go to a small model (1.5 s timeout, fails to "ask"); amounts above the approval threshold need a human. ' +
        "Authenticate with `Tab402-Agent-Signature` (agent) or a buyer API key plus `keyId`. Price always comes from the seller's quote.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                quoteId: z.string(),
                intent: z
                  .string()
                  .max(500)
                  .optional()
                  .openapi({ description: "What the purchase is for, in one line" }),
                keyId: z
                  .string()
                  .optional()
                  .openapi({ description: "Agent key, when authenticating with a buyer API key" }),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Decision",
          content: { "application/json": { schema: DecisionSchema } },
        },
        404: {
          description: "Unknown or expired quote",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Guard not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const gd = guardDeps(deps);
      if (!gd) return c.json({ error: "spend guard is not configured" }, 503);
      const body = c.req.valid("json");
      const buyerId = c.get("principal").ownerId;
      const agentKeyId = c.get("agentKeyId") ?? body.keyId;
      if (!agentKeyId) return c.json({ error: "keyId is required with a buyer API key" }, 404);
      const key = await deps.keys.get(agentKeyId);
      if (!key || key.buyerId !== buyerId) return c.json({ error: "unknown agent key" }, 404);

      const quote = await deps.db.query.quotes.findFirst({
        where: (q, { eq }) => eq(q.id, body.quoteId),
      });
      const now = deps.now?.() ?? Date.now();
      if (quote?.status !== "issued" || quote.expiresAt.getTime() <= now)
        return c.json({ error: "unknown or expired quote" }, 404);

      const d = await decide(
        gd,
        { agentKeyId, buyerId, quoteId: quote.id },
        { intent: body.intent },
      );
      return c.json(
        {
          ...d,
          approval: d.approval
            ? { ...d.approval, expiresAt: d.approval.expiresAt.toISOString() }
            : undefined,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/policy",
      tags: ["Spend guard"],
      summary: "The buyer's spending policy",
      security: [{ apiKey: [] }],
      responses: {
        200: { description: "Policy", content: { "application/json": { schema: PolicySchema } } },
      },
    }),
    async (c) => {
      const buyerId = c.get("principal").ownerId;
      await deps.db.insert(s.policies).values({ buyerId }).onConflictDoNothing();
      const p = await deps.db.query.policies.findFirst({
        where: (x, { eq }) => eq(x.buyerId, buyerId),
      });
      if (!p) throw new Error("policy missing");
      return c.json(
        {
          dailyBudget: String(p.dailyBudgetMicros),
          perCallMax: String(p.perCallMaxMicros),
          approvalThreshold: String(p.approvalThresholdMicros),
          allowlist: p.allowlist ?? null,
          blocklist: p.blocklist,
          categories: p.categories ?? null,
          version: p.version,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/policy",
      tags: ["Spend guard"],
      summary: "Update the spending policy",
      description:
        "Bumps the policy version, which clears cached guard decisions. Agents can never call this — buyer API key or dashboard only.",
      security: [{ apiKey: [] }],
      request: {
        body: {
          content: {
            "application/json": { schema: PolicySchema.omit({ version: true }).partial() },
          },
        },
      },
      responses: {
        200: {
          description: "Updated policy version",
          content: { "application/json": { schema: z.object({ version: z.number() }) } },
        },
      },
    }),
    async (c) => {
      const buyerId = c.get("principal").ownerId;
      const b = c.req.valid("json");
      await deps.db.insert(s.policies).values({ buyerId }).onConflictDoNothing();
      const [row] = await deps.db
        .update(s.policies)
        .set({
          ...(b.dailyBudget !== undefined && { dailyBudgetMicros: Number(b.dailyBudget) }),
          ...(b.perCallMax !== undefined && { perCallMaxMicros: Number(b.perCallMax) }),
          ...(b.approvalThreshold !== undefined && {
            approvalThresholdMicros: Number(b.approvalThreshold),
          }),
          ...(b.allowlist !== undefined && { allowlist: b.allowlist }),
          ...(b.blocklist !== undefined && { blocklist: b.blocklist }),
          ...(b.categories !== undefined && { categories: b.categories }),
          version: sql`${s.policies.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(s.policies.buyerId, buyerId))
        .returning({ version: s.policies.version });
      return c.json({ version: row?.version ?? 0 }, 200);
    },
  );

  const ApprovalSchema = z.object({
    id: z.string(),
    agentKeyId: z.string(),
    sellerId: z.string(),
    endpointId: z.string(),
    amount: micros,
    intent: z.string().nullable(),
    reason: z.string(),
    status: z.string(),
    expiresAt: z.string(),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/approvals",
      tags: ["Spend guard"],
      summary: "Purchases waiting for the buyer's OK",
      security: [{ apiKey: [] }],
      request: {
        query: z.object({
          status: z.enum(["pending", "approved", "denied", "expired", "used"]).default("pending"),
        }),
      },
      responses: {
        200: {
          description: "Approvals",
          content: { "application/json": { schema: z.object({ data: z.array(ApprovalSchema) }) } },
        },
      },
    }),
    async (c) => {
      const rows = await deps.db
        .select()
        .from(s.approvals)
        .where(
          and(
            eq(s.approvals.buyerId, c.get("principal").ownerId),
            eq(s.approvals.status, c.req.valid("query").status),
          ),
        )
        .orderBy(desc(s.approvals.createdAt))
        .limit(100);
      return c.json(
        {
          data: rows.map((a) => ({
            id: a.id,
            agentKeyId: a.agentKeyId,
            sellerId: a.sellerId,
            endpointId: a.endpointId,
            amount: String(a.amountMicros),
            intent: a.intent,
            reason: a.reason,
            status: a.status,
            expiresAt: a.expiresAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/approvals/{id}/decide",
      tags: ["Spend guard"],
      summary: "Approve or decline a pending purchase",
      description: "Stand-in for the passkey approval page (Phase 5).",
      security: [{ apiKey: [] }],
      request: {
        params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
        body: { content: { "application/json": { schema: z.object({ approve: z.boolean() }) } } },
      },
      responses: {
        200: {
          description: "Decided",
          content: {
            "application/json": { schema: z.object({ status: z.enum(["approved", "denied"]) }) },
          },
        },
        404: {
          description: "Not pending",
          content: { "application/json": { schema: ErrorSchema } },
        },
        410: { description: "Expired", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const r = await decideApproval(
        { db: deps.db },
        c.req.valid("param").id,
        c.get("principal").ownerId,
        c.req.valid("json").approve,
      );
      if (r === "not_found") return c.json({ error: "no pending approval with that id" }, 404);
      if (r === "expired") return c.json({ error: "approval expired" }, 410);
      return c.json({ status: r }, 200);
    },
  );

  return app;
}
