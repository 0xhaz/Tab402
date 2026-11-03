import { task } from "@renderinc/sdk/workflows";
import { createDb, parseMasterKey } from "@tab402/db";
import { DEFAULT_LEDGER_CONFIG, type Enqueue } from "@tab402/ledger";
import { PayPalClient, PayPalPayouts, PayPalWalletFunding } from "@tab402/paypal";
import { PgBoss } from "pg-boss";
import { createSettlement, type PayoutKind, runPayouts, settleDueTabs } from "./settlement";

/**
 * Tab402 settlement on Render Workflows. Each task run gets its own instance; Render retries
 * failed runs and shows every run, with its children, in the dashboard.
 *
 * Started by the `tab402-settle` cron job (src/trigger.ts). Locally: `pnpm --filter
 * @tab402/workflows dev` (needs the Render CLI), then `render workflows tasks start
 * settleDueTabs --local`.
 */

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const { db } = createDb(env("DATABASE_URL"), { max: 3 });
const paypal = new PayPalClient({
  clientId: env("PAYPAL_CLIENT_ID"),
  clientSecret: env("PAYPAL_CLIENT_SECRET"),
  env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
});

// The 24 h capture retry stays a pg-boss job on the worker. Connect only when one is needed.
let boss: Promise<PgBoss> | undefined;
const forward: Enqueue = async (name, data, options = {}) => {
  boss ??= (async () => {
    const b = new PgBoss({
      connectionString: env("DATABASE_URL"),
      schema: "pgboss",
      supervise: false,
      schedule: false,
      migrate: false,
    });
    await b.start();
    return b;
  })();
  await (await boss).send(name, data, options);
};

const log = {
  info: (obj: object, msg?: string) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
  warn: (obj: object, msg?: string) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  error: (obj: object, msg?: string) =>
    console.error(JSON.stringify({ level: "error", msg, ...obj })),
};

const settlement = createSettlement({
  db,
  funding: new PayPalWalletFunding(paypal),
  payouts: new PayPalPayouts(paypal),
  masterKey: parseMasterKey(env("TAB402_MASTER_KEY")),
  cfg: DEFAULT_LEDGER_CONFIG,
  forward,
  log,
});

// PayPal calls are retried with backoff: 30 s, 1 min, 2 min.
const paypalRetry = { maxRetries: 3, waitDurationMs: 30_000, backoffScaling: 2 };

const captureTab = task(
  { name: "captureTab", retry: paypalRetry, timeoutSeconds: 300 },
  async (_ctx, buyerId: string) => {
    await settlement.captureTab(buyerId);
    return { buyerId };
  },
);

const settlePrepaid = task(
  { name: "settlePrepaid", retry: paypalRetry, timeoutSeconds: 120 },
  async (_ctx, buyerId: string) => {
    await settlement.settlePrepaid(buyerId);
    return { buyerId };
  },
);

const topUp = task(
  { name: "topUp", retry: paypalRetry, timeoutSeconds: 300 },
  async (_ctx, buyerId: string) => {
    await settlement.topUp(buyerId);
    return { buyerId };
  },
);

task(
  // The root only fans out; its children retry, so it doesn't.
  { name: "settleDueTabs", retry: { maxRetries: 0, waitDurationMs: 0 }, timeoutSeconds: 3600 },
  (ctx) =>
    settleDueTabs(settlement, {
      captureTab: async (id) => void (await ctx.run(captureTab, id)),
      settlePrepaid: async (id) => void (await ctx.run(settlePrepaid, id)),
      topUp: async (id) => void (await ctx.run(topUp, id)),
    }),
);

const pollPayout = task(
  { name: "pollPayout", retry: paypalRetry, timeoutSeconds: 3 * 3600 },
  (_ctx, payoutId: string) => settlement.pollPayout(payoutId),
);

task(
  // PayPal errors such as INSUFFICIENT_FUNDS throw; the batch id is stable, so a retry is safe.
  {
    name: "runPayouts",
    retry: { maxRetries: 5, waitDurationMs: 60_000, backoffScaling: 2 },
    timeoutSeconds: 4 * 3600,
  },
  (ctx, kind: PayoutKind) => runPayouts(settlement, kind, (id) => ctx.run(pollPayout, id)),
);
