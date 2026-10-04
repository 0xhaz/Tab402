import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isP256PublicJwk, newId, parseMicros } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { apiKeyAuth } from "../auth";
import type { Deps, Env } from "../context";
import { AgentKeyRequestSchema, ErrorSchema } from "../schemas";

export function buyerRoutes(deps: Deps) {
  const app = new OpenAPIHono<Env>();
  app.use("/agent-keys", apiKeyAuth(deps.db, ["buyer"]));

  app.openapi(
    createRoute({
      method: "post",
      path: "/agent-keys",
      tags: ["Buyers"],
      summary: "Register an agent's public key",
      description:
        "Clients generate their P-256 key pair locally and register only the public key. Creates the agent if the name is new.",
      security: [{ apiKey: [] }],
      request: { body: { content: { "application/json": { schema: AgentKeyRequestSchema } } } },
      responses: {
        201: {
          description: "Registered key",
          content: {
            "application/json": { schema: z.object({ keyId: z.string(), agentId: z.string() }) },
          },
        },
        400: {
          description: "Invalid key",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const buyerId = c.get("principal").ownerId;
      const body = c.req.valid("json");
      if (!isP256PublicJwk(body.publicJwk))
        return c.json({ error: "publicJwk must be a P-256 public key" }, 400);

      let agent = await deps.db.query.agents.findFirst({
        where: (a, { and, eq }) => and(eq(a.buyerId, buyerId), eq(a.name, body.agentName)),
      });
      if (!agent) {
        const id = newId("agent");
        await deps.db.insert(s.agents).values({ id, buyerId, name: body.agentName });
        agent = { id, buyerId, name: body.agentName, createdAt: new Date() };
      }
      const keyId = newId("agentKey");
      await deps.db.insert(s.agentKeys).values({
        id: keyId,
        agentId: agent.id,
        buyerId,
        publicJwk: { kty: "EC", crv: "P-256", x: body.publicJwk.x, y: body.publicJwk.y },
        dailyBudgetMicros: body.dailyBudget ? parseMicros(body.dailyBudget) : null,
      });
      return c.json({ keyId, agentId: agent.id }, 201);
    },
  );

  return app;
}
