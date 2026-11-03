import { schema as s } from "@tab402/db";
import {
  buyersNeedingTopUp,
  buyersWithUnsettledPrepaid,
  dueTabs,
  type Enqueue,
  JOBS,
} from "@tab402/ledger";
import { createJobs, type WorkerDeps } from "@tab402/worker/jobs";
import { eq } from "drizzle-orm";

/**
 * Settlement as Render Workflow tasks. The money logic is the worker's own job handlers
 * (idempotent, shared with pg-boss); this module only decides how they fan out.
 *
 * - `settleDueTabs`: find due tabs, then capture each one as its own task run, in parallel.
 * - `runPayouts`: open a payout batch, submit it to PayPal, then poll it to a final state.
 *
 * The functions here take their subtask runner as an argument, so tests (and a local run)
 * can call them without Render.
 */

export type PayoutKind = "weekly" | "threshold";

export interface SettlementDeps extends Omit<WorkerDeps, "enqueue"> {
  /** Jobs the worker still owns (the 24 h capture retry) go back to its pg-boss queue. */
  forward: Enqueue;
  sleep?: (ms: number) => Promise<void>;
  pollEveryMs?: number;
  maxPolls?: number;
}

export interface SettleSummary {
  captures: number;
  prepaid: number;
  topUps: number;
  failed: string[];
}

const POLL_EVERY_MS = 60_000;
const MAX_POLLS = 120;

export function createSettlement(deps: SettlementDeps) {
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  /** The worker's handlers, with follow-up jobs routed: payout polls stay here, the rest go to pg-boss. */
  function jobs(onPoll?: (data: { payoutId: string; attempt: number }) => void) {
    const enqueue: Enqueue = async (name, data, options) => {
      if (name === JOBS.payoutPoll && onPoll) onPoll(data as { payoutId: string; attempt: number });
      else await deps.forward(name, data, options);
    };
    return createJobs({ ...deps, enqueue });
  }

  return {
    /** What is due right now. Read-only. */
    async dueWork() {
      const [tabs, prepaid, topUps] = await Promise.all([
        dueTabs(deps.db, deps.cfg, now()),
        buyersWithUnsettledPrepaid(deps.db),
        buyersNeedingTopUp(deps.db),
      ]);
      return { captures: tabs.map((t) => t.buyerId), prepaid, topUps };
    },

    /** One PayPal capture for one buyer's whole tab. Safe to retry: it resumes a pending capture. */
    captureTab: (buyerId: string) => jobs()[JOBS.capture]({ buyerId }),
    settlePrepaid: (buyerId: string) => jobs()[JOBS.prepaid]({ buyerId }),
    topUp: (buyerId: string) => jobs()[JOBS.topUp]({ buyerId }),

    /** Open and submit today's payout batch. Returns its id, or null when nobody is due. */
    async submitPayouts(kind: PayoutKind): Promise<string | null> {
      let payoutId: string | null = null;
      await jobs((d) => {
        payoutId = d.payoutId;
      })[JOBS.payoutRun]({ kind });
      return payoutId;
    },

    /** Poll PayPal until the batch is no longer processing. Returns the final payout status. */
    async pollPayout(payoutId: string): Promise<string> {
      for (let attempt = 1; attempt <= (deps.maxPolls ?? MAX_POLLS); attempt++) {
        let again = false;
        await jobs(() => {
          again = true;
        })[JOBS.payoutPoll]({ payoutId, attempt });
        if (!again) break;
        await sleep(deps.pollEveryMs ?? POLL_EVERY_MS);
      }
      const [payout] = await deps.db
        .select({ status: s.payouts.status })
        .from(s.payouts)
        .where(eq(s.payouts.id, payoutId));
      return payout?.status ?? "missing";
    },
  };
}

export type Settlement = ReturnType<typeof createSettlement>;

/** How a parent task starts a child: `ctx.run` on Render, a direct call in tests. */
export interface Subtasks {
  captureTab(buyerId: string): Promise<void>;
  settlePrepaid(buyerId: string): Promise<void>;
  topUp(buyerId: string): Promise<void>;
}

/**
 * Root task: every due tab, prepaid charge and top-up runs as its own child, all at once, so one
 * slow or failing PayPal call doesn't hold up the rest. Throws after they all finish if any failed
 * for good, so the run shows as failed in the Render dashboard.
 */
export async function settleDueTabs(settlement: Settlement, run: Subtasks): Promise<SettleSummary> {
  const due = await settlement.dueWork();
  const work = [
    ...due.captures.map((id) => ({ label: `capture ${id}`, go: () => run.captureTab(id) })),
    ...due.prepaid.map((id) => ({ label: `prepaid ${id}`, go: () => run.settlePrepaid(id) })),
    ...due.topUps.map((id) => ({ label: `top-up ${id}`, go: () => run.topUp(id) })),
  ];
  const results = await Promise.allSettled(work.map((w) => w.go()));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [work[i]?.label ?? ""] : []));
  const summary = {
    captures: due.captures.length,
    prepaid: due.prepaid.length,
    topUps: due.topUps.length,
    failed,
  };
  if (failed.length) throw new Error(`settlement: ${failed.length} failed (${failed.join(", ")})`);
  return summary;
}

/** Root task: submit the batch, then poll it in its own child run. */
export async function runPayouts(
  settlement: Settlement,
  kind: PayoutKind,
  poll: (payoutId: string) => Promise<string>,
): Promise<{ payoutId: string | null; status: string }> {
  const payoutId = await settlement.submitPayouts(kind);
  if (!payoutId) return { payoutId: null, status: "nothing due" };
  return { payoutId, status: await poll(payoutId) };
}

/**
 * Payout runs due in the 15-minute cron window containing `at` (UTC), matching the worker's
 * schedule: threshold payouts daily at 01:00, all payable sellers weekly on Monday 00:00.
 */
export function payoutsDue(at: Date): PayoutKind[] {
  const due: PayoutKind[] = [];
  const firstWindow = at.getUTCMinutes() < 15;
  if (firstWindow && at.getUTCHours() === 0 && at.getUTCDay() === 1) due.push("weekly");
  if (firstWindow && at.getUTCHours() === 1) due.push("threshold");
  return due;
}
