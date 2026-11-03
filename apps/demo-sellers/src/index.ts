import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { llmFromEnv } from "./llm";
import { logger } from "./logger";

const port = Number(process.env.DEMO_SELLERS_PORT ?? process.env.PORT ?? 4200);
const apiKey = process.env.DEMO_SELLER_API_KEY;
if (!apiKey) throw new Error("DEMO_SELLER_API_KEY is not set (see .env.example)");

const app = createApp({
  gate: {
    facilitatorUrl: process.env.TAB402_API_URL ?? "http://localhost:4000",
    apiKey,
    baseUrl: process.env.DEMO_SELLERS_URL ?? `http://localhost:${port}`,
  },
  llm: llmFromEnv(),
});

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "demo-sellers listening");
});
