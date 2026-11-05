import { createDb, NOTIFY_CHANNEL, parseMasterKey } from "@tab402/db";
import { DEFAULT_LEDGER_CONFIG, JOBS, type JobName } from "@tab402/ledger";
import { GmailSender, gmailFromEnv, vapidFromEnv, WebPushSender } from "@tab402/notify";
import { PayPalClient, PayPalPayouts, PayPalWalletFunding } from "@tab402/paypal";
import { PgBoss } from "pg-boss";
import { createJobs, SCHEDULES } from "./jobs";
import { logger } from "./logger";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const { db, sql } = createDb(env("DATABASE_URL"));
const vapid = vapidFromEnv();
if (!vapid) logger.warn("VAPID keys not set: push notifications stay queued (pnpm vapid)");
const gmail = gmailFromEnv();
const emailSecret = process.env.BETTER_AUTH_SECRET;
if (!gmail) logger.warn("GMAIL_USER / GMAIL_APP_PASSWORD not set: approval emails are off");
else if (!emailSecret) logger.warn("BETTER_AUTH_SECRET not set: approval emails are off");
const email =
  gmail && emailSecret
    ? {
        sender: new GmailSender(gmail),
        webUrl: process.env.WEB_URL || "http://localhost:3000",
        secret: emailSecret,
      }
    : undefined;
const paypal = new PayPalClient({
  clientId: env("PAYPAL_CLIENT_ID"),
  clientSecret: env("PAYPAL_CLIENT_SECRET"),
  env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
});

const boss = new PgBoss({ connectionString: env("DATABASE_URL"), schema: "pgboss" });
boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
await boss.start();

const handlers = createJobs({
  db,
  funding: new PayPalWalletFunding(paypal),
  payouts: new PayPalPayouts(paypal),
  masterKey: parseMasterKey(env("TAB402_MASTER_KEY")),
  cfg: DEFAULT_LEDGER_CONFIG,
  log: logger,
  enqueue: async (name, data, options = {}) => {
    await boss.send(name, data, options);
  },
  push: vapid ? new WebPushSender(vapid) : undefined,
  email,
});

for (const name of Object.values(JOBS) as JobName[]) {
  // Retries with backoff cover provider outages (incl. PayPal INSUFFICIENT_FUNDS on payouts).
  await boss.createQueue(name, { retryLimit: 8, retryDelay: 60, retryBackoff: true });
  await boss.work(name, async (jobs) => {
    for (const job of jobs) await (handlers[name] as (data: unknown) => Promise<void>)(job.data);
  });
}
// On Render, settlement and payouts run as Render Workflows (apps/workflows), started by a cron
// job. The worker keeps everything else, including the 24 h capture retry those tasks hand back.
const onRender = process.env.SETTLEMENT_RUNNER === "render";
const RENDER_OWNED: JobName[] = [JOBS.scan, JOBS.payoutRun];
for (const s of SCHEDULES) {
  // Schedules persist in pg-boss, so switching runners has to remove the old ones.
  if (onRender && RENDER_OWNED.includes(s.name)) await boss.unschedule(s.name, s.key);
  else await boss.schedule(s.name, s.cron, s.data ?? {}, { tz: "UTC", key: s.key });
}
// Approvals can't wait for the minute sweep: send as soon as a notification commits.
let pushing: Promise<void> | null = null;
let again = false;
const pushNow = () => {
  if (pushing) {
    again = true;
    return;
  }
  pushing = handlers[JOBS.pushSend]()
    .catch((err) => logger.error({ err }, "push delivery failed"))
    .finally(() => {
      pushing = null;
      if (again) {
        again = false;
        pushNow();
      }
    });
};
if (vapid || email) await sql.listen(NOTIFY_CHANNEL, pushNow, pushNow);

logger.info(
  { queues: Object.values(JOBS).length, settlement: onRender ? "render-workflows" : "pg-boss" },
  "worker started",
);

const shutdown = async () => {
  await boss.stop({ graceful: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
