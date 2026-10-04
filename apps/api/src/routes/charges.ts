import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { flagCharge, LedgerError, refundCharge, resolveFlag } from "@tab402/ledger";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { ErrorSchema } from "../schemas";

const Params = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "chg_01J…" }),
});
const Ok = z.object({ ok: z.literal(true) });

function ledgerError(err: unknown) {
  if (!(err instanceof LedgerError)) throw err;
  const status = err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 409;
  return { status, body: { error: err.code } } as const;
}

/** Refund netting and buyer flags. */
export function chargeRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  app.use("/charges/*", apiKeyAuth(deps.db, ["seller", "buyer"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/charges/{id}/refund",
      tags: ["Sellers"],
      summary: "Refund a charge",
      description:
        "Before capture the charge just drops off the tab; after capture the buyer is credited and the seller's net is clawed back from the next payout.",
      security: [{ apiKey: [] }],
      request: {
        params: Params,
        body: {
          content: {
            "application/json": { schema: z.object({ reason: z.string().min(1).max(200) }) },
          },
        },
      },
      responses: {
        200: {
          description: "Refunded",
          content: {
            "application/json": {
              schema: z.object({ method: z.string(), clawbackMicros: z.number() }),
            },
          },
        },
        403: {
          description: "Not your charge",
          content: { "application/json": { schema: ErrorSchema } },
        },
        404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
        409: {
          description: "Not refundable now",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const p = c.get("principal");
      if (p.ownerType !== "seller") return c.json({ error: "forbidden" }, 403);
      try {
        const r = await refundCharge(deps.db, c.req.valid("param").id, {
          sellerId: p.ownerId,
          reason: c.req.valid("json").reason,
        });
        return c.json({ method: r.method, clawbackMicros: r.clawbackMicros }, 200);
      } catch (err) {
        const e = ledgerError(err);
        return c.json(e.body, e.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/charges/{id}/flag",
      tags: ["Buyers"],
      summary: "Flag a charge (bad output, failed call)",
      description: "Holds the charge out of the next capture until the seller resolves it.",
      security: [{ apiKey: [] }],
      request: {
        params: Params,
        body: {
          content: {
            "application/json": { schema: z.object({ reason: z.string().min(1).max(200) }) },
          },
        },
      },
      responses: {
        200: { description: "Held", content: { "application/json": { schema: Ok } } },
        403: {
          description: "Sellers can't flag",
          content: { "application/json": { schema: ErrorSchema } },
        },
        404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
        409: {
          description: "Already captured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const p = c.get("principal");
      if (p.ownerType !== "buyer") return c.json({ error: "forbidden" }, 403);
      try {
        await flagCharge(deps.db, c.req.valid("param").id, p.ownerId, c.req.valid("json").reason);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        const e = ledgerError(err);
        return c.json(e.body, e.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/charges/{id}/resolve",
      tags: ["Sellers"],
      summary: "Resolve a flagged charge",
      security: [{ apiKey: [] }],
      request: {
        params: Params,
        body: { content: { "application/json": { schema: z.object({ refund: z.boolean() }) } } },
      },
      responses: {
        200: { description: "Resolved", content: { "application/json": { schema: Ok } } },
        403: {
          description: "Not your charge",
          content: { "application/json": { schema: ErrorSchema } },
        },
        404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
        409: {
          description: "Not refundable now",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const p = c.get("principal");
      if (p.ownerType !== "seller") return c.json({ error: "forbidden" }, 403);
      try {
        await resolveFlag(deps.db, c.req.valid("param").id, p.ownerId, c.req.valid("json").refund);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        const e = ledgerError(err);
        return c.json(e.body, e.status);
      }
    },
  );

  return app;
}
