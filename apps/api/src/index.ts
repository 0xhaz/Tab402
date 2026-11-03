import { serve } from "@hono/node-server";
import { TAB_NETWORKS } from "@tab402/core";
import { createDb, parseMasterKey } from "@tab402/db";
import { ClaudeGuardModel, MockGuardModel } from "@tab402/guard";
import { JOBS } from "@tab402/ledger";
import { PayPalClient, PayPalWalletFunding } from "@tab402/paypal";
import { PgBoss } from "pg-boss";
import { createApp } from "./app";
import type { Deps } from "./context";
import { AgentKeyCache } from "./key-cache";
import { logger } from "./logger";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const live = process.env.PAYPAL_ENV === "live";
const { db } = createDb(url);

// Send-only pg-boss handle; the worker consumes. Queues are created here too (send needs them).
const boss = new PgBoss({
  connectionString: url,
  schema: "pgboss",
  supervise: false,
  schedule: false,
});
boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
await boss.start();
for (const name of Object.values(JOBS))
  await boss.createQueue(name, { retryLimit: 8, retryDelay: 60, retryBackoff: true });

let paypal: Deps["paypal"];
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
  const client = new PayPalClient({
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    env: live ? "live" : "sandbox",
  });
  paypal = {
    client,
    funding: new PayPalWalletFunding(client),
    webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    skipWebhookVerification: !live && process.env.PAYPAL_WEBHOOK_SKIP_VERIFY === "1",
  };
}

// Spend guard model: Claude Haiku 4.5 when an API key is configured, else a labelled mock (dev only).
const guardModel = process.env.ANTHROPIC_API_KEY
  ? new ClaudeGuardModel({
      model: process.env.GUARD_MODEL || undefined,
      timeoutMs: Number(process.env.GUARD_TIMEOUT_MS) || undefined,
    })
  : new MockGuardModel();
if (!process.env.ANTHROPIC_API_KEY)
  logger.warn("ANTHROPIC_API_KEY not set — spend guard uses the mock model");

const app = createApp({
  db,
  keys: new AgentKeyCache(db),
  onError: (err) => logger.error({ err }, "unhandled error"),
  masterKey: process.env.TAB402_MASTER_KEY
    ? parseMasterKey(process.env.TAB402_MASTER_KEY)
    : undefined,
  paypal,
  guard: {
    model: guardModel,
    approvalBaseUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/approve`,
  },
  enqueue: async (name, data, options = {}) => {
    await boss.send(name, data, options);
  },
  config: {
    network: live ? TAB_NETWORKS.live : TAB_NETWORKS.sandbox,
    facilitatorUrl: process.env.TAB402_API_URL ?? `http://localhost:${port}`,
    quoteTtlSeconds: 300,
  },
});

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, paypal: Boolean(paypal) }, "api listening");
});
