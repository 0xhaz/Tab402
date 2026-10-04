import {
  type GateOptions,
  type GateVariables,
  tab402Discovery,
  tab402Gate,
} from "@tab402/sdk-server";
import { Hono } from "hono";
import { z } from "zod";
import { costMicros, type Llm } from "./llm";

/** Our own demo sellers: one fixed-price API and one metered AI-model endpoint. */
export const DEMO_ROUTES = {
  "POST /v1/summarize": {
    pricing: "fixed",
    price: 10_000,
    description: "Summarize text",
    category: "llm",
  },
  "POST /v1/chat": {
    pricing: "metered",
    price: 50_000,
    description: "Chat with a model (metered, provider cost × 1.3)",
    category: "llm",
  },
} satisfies GateOptions["routes"];

const SummarizeBody = z.object({ text: z.string().min(1).max(50_000) });
const ChatBody = z.object({
  message: z.string().min(1).max(20_000),
  system: z.string().max(4_000).optional(),
});

/** The demo sellers' own API description — the onboarding agent's demo input (Phase 7 exit). */
export function demoOpenApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tab402 Demo Sellers",
      version: "1.0.0",
      description: "Text summarization and chat backed by Claude.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "OK" } } } },
      "/v1/summarize": {
        post: {
          operationId: "summarize",
          summary: "Summarize text in two or three sentences",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: { text: { type: "string", maxLength: 50_000 } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Summary",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { summary: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/v1/chat": {
        post: {
          operationId: "chat",
          summary: "Chat with a language model",
          description: "One message in, one reply out. Cost depends on tokens used.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: { message: { type: "string" }, system: { type: "string" } },
                },
              },
            },
          },
          responses: { "200": { description: "Reply", content: { "application/json": {} } } },
        },
      },
    },
  };
}

export interface DemoSellerDeps {
  gate: Omit<GateOptions, "routes">;
  llm: Llm;
}

export function createApp({ gate, llm }: DemoSellerDeps): Hono<{ Variables: GateVariables }> {
  const app = new Hono<{ Variables: GateVariables }>();
  app.get("/health", (c) => c.json({ ok: true, service: "demo-sellers" }));

  app.use("/v1/*", tab402Gate({ ...gate, routes: DEMO_ROUTES }));
  app.get("/.well-known/x402", tab402Discovery(gate));
  app.get("/openapi.json", (c) => c.json(demoOpenApi(gate.baseUrl)));

  app.post("/v1/summarize", async (c) => {
    const body = SummarizeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "body must be { text: string }" }, 400);
    const out = await llm.complete({
      system: "Summarize the user's text in two or three sentences. Reply with the summary only.",
      prompt: body.data.text,
      maxTokens: 1024,
    });
    return c.json({ summary: out.text, model: out.model });
  });

  app.post("/v1/chat", async (c) => {
    const body = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: "body must be { message: string, system?: string }" }, 400);
    const out = await llm.complete({
      system: body.data.system,
      prompt: body.data.message,
      maxTokens: 1024,
    });
    const cost = costMicros(out);
    c.var.tab402.setActualCost(cost);
    return c.json({
      reply: out.text,
      model: out.model,
      usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
      costMicros: cost,
    });
  });

  return app;
}
