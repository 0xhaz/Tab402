import { schema as s } from "@tab402/db";
import { DEFAULT_LEDGER_CONFIG, JOBS } from "@tab402/ledger";
import { registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import {
  createSettlement,
  payoutsDue,
  runPayouts,
  type Settlement,
  settleDueTabs,
} from "@tab402/workflows/settlement";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS, SELLERS2 } from "./harness";

const h = await createHarness();
afterAll(h.close);

const DAY = 24 * 3600_000;
const body = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Settle this tab on Render." }),
};

let settlement: Settlement;
/** Children run inline here; on Render each is `ctx.run(task, …)` on its own instance. */
const inline = () => ({
  captureTab: (id: string) => settlement.captureTab(id),
  settlePrepaid: (id: string) => settlement.settlePrepaid(id),
  topUp: (id: string) => settlement.topUp(id),
});

async function spend(calls: number) {
  const a = await registerAgentKey({
    apiUrl: API,
    buyerApiKey: h.buyerKey,
    agentName: "workflow-test",
    fetch: h.router,
  });
  const client = new Tab402Client({ keyId: a.keyId, privateKey: a.privateKey, fetch: h.router });
  for (let i = 0; i < calls; i++) {
    const res = await client.fetch(`${i % 2 ? SELLERS2 : SELLERS}/v1/summarize`, body);
    expect(res.status).toBe(200);
  }
}

const states = async () =>
  (await h.db.select({ state: s.charges.state }).from(s.charges)).reduce<Record<string, number>>(
    (a, r) => {
      a[r.state] = (a[r.state] ?? 0) + 1;
      return a;
    },
    {},
  );

describe("settlement on Render Workflows", () => {
  beforeEach(async () => {
    await h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 });
    settlement = createSettlement({
      db: h.db,
      funding: h.paypal,
      payouts: h.paypal,
      masterKey: h.masterKey,
      cfg: DEFAULT_LEDGER_CONFIG,
      forward: h.enqueue,
      now: h.now,
      log: { info() {}, warn() {}, error() {} },
      sleep: async () => {},
    });
  });

  it("settleDueTabs captures a due tab once, and a second run finds nothing", async () => {
    await spend(200); // $2.00 across two sellers
    expect(await settleDueTabs(settlement, inline())).toEqual({
      captures: 0,
      prepaid: 0,
      topUps: 0,
      failed: [],
    });

    h.setClock(() => new Date(Date.now() + DAY + 3600_000)); // past the 24 h due time
    const summary = await settleDueTabs(settlement, inline());
    expect(summary).toMatchObject({ captures: 1, failed: [] });
    expect(h.paypal.captures).toHaveLength(1);
    expect(h.paypal.captures[0]?.amountMicros).toBe(2_000_000);
    expect(await states()).toEqual({ collected: 200 });

    expect(await settleDueTabs(settlement, inline())).toMatchObject({ captures: 0 });
    expect(h.paypal.captures).toHaveLength(1);
  });

  it("a retried capture task resumes the same settlement instead of charging twice", async () => {
    await spend(150);
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    const [due] = (await settlement.dueWork()).captures;
    expect(due).toBeDefined();
    // Render retries a child whose instance died mid-run: the handler runs again for the same buyer.
    await Promise.all([settlement.captureTab(due as string), settlement.captureTab(due as string)]);
    await settlement.captureTab(due as string);
    expect(h.paypal.captures).toHaveLength(1);
    expect(await h.db.select().from(s.settlements)).toHaveLength(1);
  });

  it("a child that fails for good fails the run, and names it", async () => {
    await spend(120);
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    await expect(
      settleDueTabs(settlement, {
        ...inline(),
        captureTab: async () => {
          throw new Error("PayPal 503");
        },
      }),
    ).rejects.toThrow(/1 failed \(capture buy_e2e\)/);
    expect(await states()).toEqual({ earned: 120 });
  });

  it("a declined capture hands its 24 h retry back to the worker's queue", async () => {
    await spend(120);
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    h.paypal.declineNext = 1;
    await settleDueTabs(settlement, inline());
    const retry = h.queued.find((j) => j.name === JOBS.retryCapture);
    expect(retry?.options?.startAfter).toBe(24 * 3600);
  });

  it("runPayouts submits one batch and polls it to success", async () => {
    await spend(200);
    h.setClock(() => new Date(Date.now() + DAY + 3600_000));
    await settleDueTabs(settlement, inline());

    const result = await runPayouts(settlement, "weekly", (id) => settlement.pollPayout(id));
    expect(result.status).toBe("success");
    expect(h.paypal.payouts).toHaveLength(1);
    expect(h.paypal.payouts[0]?.items).toHaveLength(2);
    expect(await states()).toEqual({ paid_out: 200 });
    // Polls were run in the task, not left on the queue.
    expect(h.queued.filter((j) => j.name === JOBS.payoutPoll)).toHaveLength(0);

    // A repeated run the same day (cron tick, Render retry) reuses the batch: nothing new is sent.
    const again = await runPayouts(settlement, "weekly", (id) => settlement.pollPayout(id));
    expect(again).toEqual({ payoutId: result.payoutId, status: "success" });
    expect(h.paypal.payouts).toHaveLength(1);
  });
});

describe("payout schedule for the cron trigger", () => {
  it("weekly on Monday 00:00 UTC, threshold daily at 01:00 UTC, only in the first window", () => {
    expect(payoutsDue(new Date("2026-11-02T00:05:00Z"))).toEqual(["weekly"]); // Monday
    expect(payoutsDue(new Date("2026-11-02T01:10:00Z"))).toEqual(["threshold"]);
    expect(payoutsDue(new Date("2026-11-03T01:00:00Z"))).toEqual(["threshold"]);
    expect(payoutsDue(new Date("2026-11-03T01:15:00Z"))).toEqual([]);
    expect(payoutsDue(new Date("2026-11-03T00:05:00Z"))).toEqual([]); // Tuesday
  });
});
