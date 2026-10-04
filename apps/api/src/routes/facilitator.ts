import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { TAB_NETWORKS, TAB_SCHEME, X402_VERSION } from "@tab402/core";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { settlePayment, verifyPayment } from "../payments";
import {
  asRequirements,
  SettleRequestSchema,
  SettleResponseSchema,
  VerifyRequestSchema,
  VerifyResponseSchema,
} from "../schemas";

/** x402 facilitator API for the `tab` scheme. */
export function facilitatorRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/supported",
      tags: ["Facilitator"],
      summary: "Schemes and networks this facilitator handles",
      responses: {
        200: {
          description: "Supported kinds",
          content: { "application/json": { schema: SupportedSchema() } },
        },
      },
    }),
    (c) =>
      c.json({
        kinds: Object.values(TAB_NETWORKS).map((network) => ({
          x402Version: X402_VERSION,
          scheme: TAB_SCHEME,
          network,
        })),
        extensions: [],
        signers: {},
      }),
  );

  app.use("/verify", apiKeyAuth(deps.db, ["seller"]));
  app.use("/settle", apiKeyAuth(deps.db, ["seller"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/verify",
      tags: ["Facilitator"],
      summary: "Check a voucher without committing anything",
      security: [{ apiKey: [] }],
      request: { body: { content: { "application/json": { schema: VerifyRequestSchema } } } },
      responses: {
        200: {
          description: "Verification result",
          content: { "application/json": { schema: VerifyResponseSchema } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const res = await verifyPayment(
        deps,
        c.get("principal").ownerId,
        body.paymentPayload,
        asRequirements(body.paymentRequirements),
      );
      return c.json(res, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/settle",
      tags: ["Facilitator"],
      summary: "Record the charge on the buyer's tab",
      description:
        "Money moves later in batch settlement. For metered pricing pass the actual cost in `amount`.",
      security: [{ apiKey: [] }],
      request: { body: { content: { "application/json": { schema: SettleRequestSchema } } } },
      responses: {
        200: {
          description: "Settlement result",
          content: { "application/json": { schema: SettleResponseSchema } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const res = await settlePayment(
        deps,
        c.get("principal").ownerId,
        body.paymentPayload,
        asRequirements(body.paymentRequirements),
        body.amount,
      );
      return c.json(res, 200);
    },
  );

  return app;
}

function SupportedSchema() {
  return z
    .object({
      kinds: z.array(
        z.object({ x402Version: z.number(), scheme: z.string(), network: z.string() }),
      ),
      extensions: z.array(z.string()),
      signers: z.record(z.string(), z.array(z.string())),
    })
    .openapi("SupportedResponse");
}
