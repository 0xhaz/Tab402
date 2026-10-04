import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  buildTabRequirements,
  newId,
  type PaymentRequired,
  parseMicros,
  X402_VERSION,
} from "@tab402/core";
import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import {
  EndpointInputSchema,
  ErrorSchema,
  PaymentRequiredSchema,
  QuoteRequestSchema,
} from "../schemas";

/** Endpoint URLs are matched on origin + path; query strings don't change the price. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`;
}

export function sellerRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  app.use("/quotes", apiKeyAuth(deps.db, ["seller"]));
  app.use("/endpoints", apiKeyAuth(deps.db, ["seller"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/quotes",
      tags: ["Sellers"],
      summary: "Issue a 402 quote for a paid endpoint",
      description: "Every quote is recorded, powering 402 → paid conversion analytics.",
      security: [{ apiKey: [] }],
      request: { body: { content: { "application/json": { schema: QuoteRequestSchema } } } },
      responses: {
        201: {
          description: "Payment requirements to return with HTTP 402",
          content: { "application/json": { schema: PaymentRequiredSchema } },
        },
        404: {
          description: "Not a paid endpoint",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { method, url } = c.req.valid("json");
      const sellerId = c.get("principal").ownerId;
      const endpoint = await deps.db.query.endpoints.findFirst({
        where: (e, { and, eq }) =>
          and(
            eq(e.sellerId, sellerId),
            eq(e.method, method.toUpperCase()),
            eq(e.url, normalizeUrl(url)),
            eq(e.active, true),
          ),
      });
      if (!endpoint) return c.json({ error: "no paid endpoint for this method and URL" }, 404);

      const quoteId = newId("quote");
      const nowMs = deps.now?.() ?? Date.now();
      await deps.db.insert(s.quotes).values({
        id: quoteId,
        endpointId: endpoint.id,
        sellerId,
        amountMicros: endpoint.priceMicros,
        pricingMode: endpoint.pricingMode,
        expiresAt: new Date(nowMs + deps.config.quoteTtlSeconds * 1000),
      });

      const paymentRequired: PaymentRequired = {
        x402Version: X402_VERSION,
        error: "PAYMENT-SIGNATURE header is required",
        resource: {
          url: endpoint.url,
          description: endpoint.description ?? undefined,
          mimeType: "application/json",
        },
        accepts: [
          buildTabRequirements({
            network: deps.config.network,
            amountMicros: endpoint.priceMicros,
            sellerId,
            quoteId,
            pricing: endpoint.pricingMode,
            facilitatorUrl: deps.config.facilitatorUrl,
            maxTimeoutSeconds: deps.config.quoteTtlSeconds,
          }),
        ],
      };
      return c.json(paymentRequired as z.infer<typeof PaymentRequiredSchema>, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/endpoints",
      tags: ["Sellers"],
      summary: "Register or update priced endpoints",
      description:
        "Upserts by (method, URL). Used by the gate middleware's route config and by onboarding.",
      security: [{ apiKey: [] }],
      request: {
        body: {
          content: {
            "application/json": { schema: z.object({ endpoints: z.array(EndpointInputSchema) }) },
          },
        },
      },
      responses: {
        200: {
          description: "Registered endpoints",
          content: {
            "application/json": {
              schema: z.object({
                endpoints: z.array(
                  z.object({ id: z.string(), method: z.string(), url: z.string() }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const sellerId = c.get("principal").ownerId;
      const out: { id: string; method: string; url: string }[] = [];
      for (const e of c.req.valid("json").endpoints) {
        const method = e.method.toUpperCase();
        const url = normalizeUrl(e.url);
        const values = {
          pricingMode: e.pricing,
          priceMicros: parseMicros(e.price),
          description: e.description ?? null,
          category: e.category ?? null,
          active: true,
        };
        const existing = await deps.db.query.endpoints.findFirst({
          where: (x, { and, eq }) =>
            and(eq(x.sellerId, sellerId), eq(x.method, method), eq(x.url, url)),
        });
        if (existing) {
          await deps.db.update(s.endpoints).set(values).where(eq(s.endpoints.id, existing.id));
          out.push({ id: existing.id, method, url });
        } else {
          const id = newId("endpoint");
          await deps.db.insert(s.endpoints).values({ id, sellerId, method, url, ...values });
          out.push({ id, method, url });
        }
      }
      return c.json({ endpoints: out }, 200);
    },
  );

  return app;
}
