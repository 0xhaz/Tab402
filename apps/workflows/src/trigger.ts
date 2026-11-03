import { Render } from "@renderinc/sdk";
import { payoutsDue } from "./settlement";

/**
 * Cron entry point (Render Cron Job `tab402-settle`, every 15 minutes). Starts the settlement
 * workflow and exits without waiting; the run and its children show in the Render dashboard.
 *
 *   tsx src/trigger.ts             settleDueTabs, plus payouts when their time has come
 *   tsx src/trigger.ts payouts weekly|threshold
 *
 * Payouts keep the worker's old schedule: threshold payouts daily at 01:00 UTC, all payable
 * sellers weekly on Monday 00:00 UTC. A date-based idempotency key makes a repeated tick harmless.
 * Needs RENDER_API_KEY. WORKFLOW_SLUG is the workflow service's slug (default tab402-settlement).
 */

const slug = process.env.WORKFLOW_SLUG ?? "tab402-settlement";
const render = new Render();

async function start(taskName: string, input: unknown[], idempotencyKey?: string) {
  const run = await render.workflows.startTask(`${slug}/${taskName}`, input, { idempotencyKey });
  console.log(`started ${slug}/${taskName} ${JSON.stringify(input)} → ${run.taskRunId}`);
}

const [cmd, arg] = process.argv.slice(2);
const now = new Date();
const today = now.toISOString().slice(0, 10);

if (cmd === "payouts") {
  if (arg !== "weekly" && arg !== "threshold")
    throw new Error("usage: trigger.ts payouts weekly|threshold");
  await start("runPayouts", [arg], `payouts-${arg}-${today}`);
} else {
  const window = new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();
  await start("settleDueTabs", [], `settle-${window}`);
  for (const kind of payoutsDue(now)) await start("runPayouts", [kind], `payouts-${kind}-${today}`);
}
