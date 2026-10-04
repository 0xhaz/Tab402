import { randomBytes } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { newId } from "@tab402/core";
import { schema as s, sealSecret } from "@tab402/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { ErrorSchema } from "../schemas";

/** Seller settings: payout receiver, webhook endpoint, and the polling events API. */
export function merchantRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  app.use("/seller/*", apiKeyAuth(deps.db, ["seller"]));
  app.use("/events", apiKeyAuth(deps.db, ["seller"]));

  app.openapi(
    createRoute({
      method: "put",
      path: "/seller/payout",
      tags: ["Sellers"],
      summary: "Set where payouts go",
      security: [{ apiKey: [] }],
      request: {
        body: { content: { "application/json": { schema: z.object({ receiver: z.email() }) } } },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: z.object({ receiver: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const { receiver } = c.req.valid("json");
      await deps.db
        .update(s.sellers)
        .set({ payoutReceiver: receiver })
        .where(eq(s.sellers.id, c.get("principal").ownerId));
      return c.json({ receiver }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/seller/webhook",
      tags: ["Sellers"],
      summary: "Set the webhook URL",
      description:
        'Events are POSTed with `Tab402-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. The signing secret is returned when first created or rotated, and never again.',
      security: [{ apiKey: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ url: z.url(), rotateSecret: z.boolean().default(false) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: {
            "application/json": {
              schema: z.object({ url: z.string(), secret: z.string().optional() }),
            },
          },
        },
        503: {
          description: "Secrets not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!deps.masterKey) return c.json({ error: "secret storage is not configured" }, 503);
      const sellerId = c.get("principal").ownerId;
      const { url, rotateSecret } = c.req.valid("json");
      await deps.db.update(s.sellers).set({ webhookUrl: url }).where(eq(s.sellers.id, sellerId));

      const existing = await deps.db.query.merchantSecrets.findFirst({
        where: (m, { and, eq }) =>
          and(eq(m.ownerId, sellerId), eq(m.kind, "webhook_signing_secret")),
      });
      if (existing && !rotateSecret) return c.json({ url }, 200);
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const blob = sealSecret(deps.masterKey, sellerId, "webhook_signing_secret", secret);
      await deps.db
        .insert(s.merchantSecrets)
        .values({ id: newId("secret"), ownerId: sellerId, kind: "webhook_signing_secret", blob })
        .onConflictDoUpdate({
          target: [s.merchantSecrets.ownerId, s.merchantSecrets.kind],
          set: { blob, createdAt: new Date() },
        });
      return c.json({ url, secret }, 200);
    },
  );

  const Event = z.object({
    id: z.string(),
    type: z.string(),
    created: z.number(),
    api_version: z.string(),
    data: z.record(z.string(), z.unknown()),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags: ["Sellers"],
      summary: "List events (polling alternative to webhooks)",
      security: [{ apiKey: [] }],
      request: {
        query: z.object({
          after: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: {
        200: {
          description: "Events, oldest first",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(Event), hasMore: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { after, limit } = c.req.valid("query");
      const rows = await deps.db
        .select({ payload: s.eventsOut.payload })
        .from(s.eventsOut)
        .where(
          and(
            eq(s.eventsOut.sellerId, c.get("principal").ownerId),
            after ? gt(s.eventsOut.id, after) : undefined,
          ),
        )
        .orderBy(asc(s.eventsOut.id))
        .limit(limit + 1);
      return c.json(
        {
          data: rows.slice(0, limit).map((r) => r.payload as z.infer<typeof Event>),
          hasMore: rows.length > limit,
        },
        200,
      );
    },
  );

  return app;
}
