import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { facilitatorManifest, resourceServerManifest, TAB_NETWORKS } from "@tab402/core";
import { directoryCategories, searchDirectory } from "@tab402/db";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { ErrorSchema } from "../schemas";

const ListingSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    method: z.string(),
    seller: z.string(),
    sellerId: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    pricing: z.enum(["fixed", "metered"]),
    price: z.string().openapi({ example: "$0.01" }),
    priceMicros: z.number().int(),
    paidCalls30d: z.number().int(),
  })
  .openapi("Listing");

const ManifestSchema = z
  .object({ x402Version: z.literal(2), kind: z.string() })
  .passthrough()
  .openapi("X402Manifest", { description: "draft-hawkins-x402-dns-discovery-01 manifest" });

/** The Tab402 directory: public, read-only, no buyer data. Plus `/.well-known/x402` manifests. */
export function directoryRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  const publicCache = "public, max-age=60";

  app.openapi(
    createRoute({
      method: "get",
      path: "/directory",
      tags: ["Directory"],
      summary: "Search paid APIs",
      description:
        "Every active priced endpoint, ranked by how many query words match, then by paid calls in the last 30 days.",
      request: {
        query: z.object({
          q: z.string().max(200).optional(),
          category: z.string().max(64).optional(),
          seller: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).max(10_000).default(0),
        }),
      },
      responses: {
        200: {
          description: "Matching endpoints",
          content: { "application/json": { schema: z.object({ data: z.array(ListingSchema) }) } },
        },
      },
    }),
    async (c) => {
      const { q, category, seller, limit, offset } = c.req.valid("query");
      const data = await searchDirectory(deps.db, { q, category, sellerId: seller, limit, offset });
      c.header("cache-control", publicCache);
      c.header("access-control-allow-origin", "*");
      return c.json({ data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/directory/categories",
      tags: ["Directory"],
      summary: "Categories in use",
      responses: {
        200: {
          description: "Categories with endpoint counts",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(z.object({ category: z.string(), endpoints: z.number().int() })),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      c.header("cache-control", publicCache);
      c.header("access-control-allow-origin", "*");
      return c.json({ data: await directoryCategories(deps.db) }, 200);
    },
  );

  const sellerManifest = async (sellerId: string, origin?: string) => {
    const seller = await deps.db.query.sellers.findFirst({
      where: (s, { and, eq }) => and(eq(s.id, sellerId), eq(s.status, "active")),
    });
    if (!seller) return null;
    const endpoints = (await searchDirectory(deps.db, { sellerId, limit: 100 })).filter(
      (e) => !origin || new URL(e.url).origin === origin,
    );
    return resourceServerManifest({
      name: seller.name,
      network: deps.config.network,
      endpoints,
    });
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/directory/sellers/{id}/x402",
      tags: ["Directory"],
      summary: "A seller's /.well-known/x402 manifest",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Manifest",
          content: { "application/json": { schema: ManifestSchema } },
        },
        404: {
          description: "No such seller",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const manifest = await sellerManifest(c.req.valid("param").id);
      if (!manifest) return c.json({ error: "not_found" }, 404);
      c.header("cache-control", publicCache);
      c.header("access-control-allow-origin", "*");
      return c.json(manifest, 200);
    },
  );

  app.use("/seller/x402", apiKeyAuth(deps.db, ["seller"]));
  app.openapi(
    createRoute({
      method: "get",
      path: "/seller/x402",
      tags: ["Sellers"],
      summary: "Your /.well-known/x402 manifest",
      description:
        "Generated from your registered endpoints. The SDK serves it at /.well-known/x402 on your API; `origin` limits it to endpoints on that host, as the draft requires.",
      security: [{ apiKey: [] }],
      request: { query: z.object({ origin: z.url().optional() }) },
      responses: {
        200: {
          description: "Manifest",
          content: { "application/json": { schema: ManifestSchema } },
        },
        404: {
          description: "Seller suspended",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { origin } = c.req.valid("query");
      const manifest = await sellerManifest(
        c.get("principal").ownerId,
        origin ? new URL(origin).origin : undefined,
      );
      if (!manifest) return c.json({ error: "seller_suspended" }, 404);
      return c.json(manifest, 200);
    },
  );

  app.get("/.well-known/x402", (c) => {
    c.header("cache-control", "public, max-age=300");
    c.header("access-control-allow-origin", "*");
    return c.json(
      facilitatorManifest({
        baseUrl: deps.config.facilitatorUrl,
        networks: [
          deps.config.network === TAB_NETWORKS.live ? TAB_NETWORKS.live : TAB_NETWORKS.sandbox,
        ],
        docs: `${deps.config.facilitatorUrl}/docs`,
      }),
    );
  });

  return app;
}
