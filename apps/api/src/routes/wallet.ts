import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { floorToCents } from "@tab402/core";
import { beginWalletMandate, completeWalletMandate, JOBS } from "@tab402/ledger";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { ErrorSchema } from "../schemas";

/**
 * Buyer wallet: save a PayPal wallet without a purchase (Vault v3), then fund
 * prepaid balances from it. The vault token is sealed server-side and never returned.
 */
export function walletRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  app.use("/wallet/*", apiKeyAuth(deps.db, ["buyer"]));
  app.use("/balance/*", apiKeyAuth(deps.db, ["buyer"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/wallet/setup",
      tags: ["Buyers"],
      summary: "Start saving a PayPal wallet",
      description:
        "Returns PayPal's approval URL. After the buyer approves, call /wallet/complete.",
      security: [{ apiKey: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                returnUrl: z.url(),
                cancelUrl: z.url(),
                mode: z.enum(["prepaid", "postpaid"]).default("prepaid"),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Pending mandate",
          content: {
            "application/json": {
              schema: z.object({ mandateId: z.string(), approveUrl: z.url() }),
            },
          },
        },
        503: {
          description: "PayPal not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!deps.paypal) return c.json({ error: "PayPal is not configured" }, 503);
      const buyerId = c.get("principal").ownerId;
      const body = c.req.valid("json");
      const { mandateId, approveUrl } = await beginWalletMandate(deps.db, deps.paypal.funding, {
        buyerId,
        mode: body.mode,
        returnUrl: body.returnUrl,
        cancelUrl: body.cancelUrl,
      });
      return c.json({ mandateId, approveUrl }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/wallet/complete",
      tags: ["Buyers"],
      summary: "Finish saving the wallet after PayPal approval",
      security: [{ apiKey: [] }],
      request: {
        body: { content: { "application/json": { schema: z.object({ mandateId: z.string() }) } } },
      },
      responses: {
        200: {
          description: "Active mandate",
          content: {
            "application/json": {
              schema: z.object({
                mandateId: z.string(),
                mode: z.string(),
                payerEmail: z.string().nullable(),
              }),
            },
          },
        },
        404: {
          description: "No pending mandate",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "PayPal not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!deps.paypal || !deps.masterKey)
        return c.json({ error: "PayPal is not configured" }, 503);
      const buyerId = c.get("principal").ownerId;
      const { mandateId } = c.req.valid("json");
      const done = await completeWalletMandate(deps.db, deps.paypal.funding, deps.masterKey, {
        buyerId,
        mandateId,
      });
      if (!done) return c.json({ error: "no pending mandate" }, 404);
      if (done.mode === "prepaid")
        await deps.enqueue?.(JOBS.topUp, { buyerId }, { singletonKey: buyerId });
      return c.json(done, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/balance/top-up",
      tags: ["Buyers"],
      summary: "Top up the prepaid balance from the saved wallet",
      security: [{ apiKey: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                amount: z
                  .string()
                  .regex(/^\d+$/)
                  .optional()
                  .openapi({ description: "Micro-USD, whole cents" }),
              }),
            },
          },
        },
      },
      responses: {
        202: {
          description: "Top-up queued",
          content: { "application/json": { schema: z.object({ queued: z.boolean() }) } },
        },
        503: {
          description: "Worker not connected",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!deps.enqueue) return c.json({ error: "background jobs are not configured" }, 503);
      const buyerId = c.get("principal").ownerId;
      const amount = c.req.valid("json").amount;
      await deps.enqueue(
        JOBS.topUp,
        { buyerId, amountMicros: amount ? floorToCents(Number(amount)).cents : undefined },
        { singletonKey: buyerId },
      );
      return c.json({ queued: true }, 202);
    },
  );

  return app;
}
