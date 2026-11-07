import { type GateOptions, type GateVariables, tab402Gate } from "@tab402/sdk-server";
import type { Hono } from "hono";
import { z } from "zod";
import { costMicros, type Llm } from "./llm";

/**
 * A second demo API, "Tab402 Text Tools", mounted under /tools. It has no prices in code: the
 * gate quotes whatever the seller confirmed in onboarding, so it is the API to price on camera.
 * Until it is onboarded, its paid routes answer 500 "endpoint is not priced in Tab402".
 */
export const TOOLS_PREFIX = "/tools";

const TranslateBody = z.object({
  text: z.string().min(1).max(20_000),
  to: z.string().min(2).max(40),
});
const KeywordsBody = z.object({ text: z.string().min(1).max(50_000) });

const json = (schema: Record<string, unknown>) => ({
  required: true,
  content: { "application/json": { schema } },
});

export function toolsOpenApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tab402 Text Tools",
      version: "1.0.0",
      description: "Translation and keyword extraction backed by Claude.",
    },
    servers: [{ url: `${baseUrl.replace(/\/+$/, "")}${TOOLS_PREFIX}` }],
    paths: {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "OK" } } } },
      "/v1/translate": {
        post: {
          operationId: "translate",
          summary: "Translate text into another language",
          description: "Cost depends on the length of the text.",
          requestBody: json({
            type: "object",
            required: ["text", "to"],
            properties: {
              text: { type: "string", maxLength: 20_000 },
              to: { type: "string", description: 'Target language, e.g. "French"' },
            },
          }),
          responses: { "200": { description: "Translation" } },
        },
      },
      "/v1/keywords": {
        post: {
          operationId: "keywords",
          summary: "Extract up to ten keywords from text",
          requestBody: json({
            type: "object",
            required: ["text"],
            properties: { text: { type: "string", maxLength: 50_000 } },
          }),
          responses: { "200": { description: "Keywords" } },
        },
      },
    },
  };
}

/** Mount Text Tools on the demo sellers' app. */
export function mountTools(
  app: Hono<{ Variables: GateVariables }>,
  { gate, llm }: { gate: Omit<GateOptions, "routes">; llm: Llm },
) {
  app.get(`${TOOLS_PREFIX}/health`, (c) => c.json({ ok: true, service: "text-tools" }));
  app.get(`${TOOLS_PREFIX}/openapi.json`, (c) => c.json(toolsOpenApi(gate.baseUrl)));
  // No `routes`: every call under /tools/v1 is paid at the price confirmed in Tab402.
  app.use(`${TOOLS_PREFIX}/v1/*`, tab402Gate(gate));

  app.post(`${TOOLS_PREFIX}/v1/translate`, async (c) => {
    const body = TranslateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "body must be { text: string, to: string }" }, 400);
    const out = await llm.complete({
      system: `Translate the user's text into ${body.data.to}. Reply with the translation only.`,
      prompt: body.data.text,
      maxTokens: 2048,
    });
    if (c.var.tab402.pricing === "metered") c.var.tab402.setActualCost(costMicros(out));
    return c.json({ translation: out.text, to: body.data.to, model: out.model });
  });

  app.post(`${TOOLS_PREFIX}/v1/keywords`, async (c) => {
    const body = KeywordsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "body must be { text: string }" }, 400);
    const out = await llm.complete({
      system:
        "List up to ten keywords from the user's text, one per line, most important first. Reply with the list only.",
      prompt: body.data.text,
      maxTokens: 256,
    });
    if (c.var.tab402.pricing === "metered") c.var.tab402.setActualCost(costMicros(out));
    const keywords = out.text
      .split("\n")
      .map((k) => k.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 10);
    return c.json({ keywords, model: out.model });
  });
}
