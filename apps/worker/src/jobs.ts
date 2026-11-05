import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "@tab402/core";
import { type Database, openSecret, schema as s } from "@tab402/db";
import {
  buyersNeedingTopUp,
  buyersWithUnsettledPrepaid,
  type CaptureRequest,
  dueTabs,
  type Enqueue,
  JOBS,
  type JobName,
  type LedgerConfig,
  markSettlementDisputed,
  markSettlementMatched,
  markSettlementRejected,
  openCaptureSettlement,
  openPayoutRun,
  openTopUp,
  type ProviderItemStatus,
  pendingCaptureRequest,
  recordCaptureResult,
  recordPayoutResults,
  recordPayoutSubmitted,
  recordTopUp,
  retryCaptureSettlement,
  settlePrepaid,
  unreconciledSettlements,
  writeOffSettlement,
} from "@tab402/ledger";
import {
  deliverApprovalEmails,
  deliverNotifications,
  type EmailSender,
  type PushSender,
} from "@tab402/notify";
import type { FundingAdapter, PayoutAdapter, PayPalWebhookEvent } from "@tab402/paypal";
import { payPalToMicros } from "@tab402/paypal";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  db: Database;
  funding: FundingAdapter;
  payouts: PayoutAdapter;
  masterKey: Buffer;
  cfg: LedgerConfig;
  enqueue: Enqueue;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Web Push (VAPID). Without it, notifications stay queued until push is configured. */
  push?: PushSender;
  /** Approval emails (Gmail SMTP). Links point at webUrl; decline links are signed with secret. */
  email?: { sender: EmailSender; webUrl: string; secret: string };
}

const RETRY_CAPTURE_AFTER_SECONDS = 24 * 3600;
const POLL_PAYOUT_EVERY_SECONDS = 60;
const MAX_PAYOUT_POLLS = 120;
const EVENT_MAX_AGE_MS = 24 * 3600_000;

async function vaultToken(
  deps: WorkerDeps,
  ownerId: string,
  secretId: string | null,
): Promise<string> {
  if (!secretId) throw new Error(`mandate ${ownerId} has no vault token`);
  const [secret] = await deps.db
    .select()
    .from(s.merchantSecrets)
    .where(eq(s.merchantSecrets.id, secretId));
  if (!secret) throw new Error(`vault secret ${secretId} missing`);
  return openSecret(deps.masterKey, secret.ownerId, secret.kind, secret.blob);
}

/** Every job handler. Each is idempotent: pg-boss may run a job more than once. */
export function createJobs(deps: WorkerDeps) {
  const now = () => deps.now?.() ?? new Date();

  async function charge(req: CaptureRequest) {
    const result = await deps.funding.capture({
      vaultToken: await vaultToken(deps, req.mandateId, req.vaultSecretId),
      amountMicros: req.amountMicros,
      reference: req.settlementId,
      description: "Tab402 — agent API usage",
      lines: req.lines,
      idempotencyKey: req.idempotencyKey,
    });
    const recorded = await recordCaptureResult(deps.db, req.settlementId, result, deps.cfg, now());
    deps.log.info(
      {
        settlementId: req.settlementId,
        buyerId: req.buyerId,
        amount: req.amountMicros,
        result: recorded,
      },
      "capture",
    );
    if (recorded.status === "declined") {
      if (recorded.final) {
        const n = await writeOffSettlement(deps.db, req.settlementId, now());
        deps.log.warn({ settlementId: req.settlementId, charges: n }, "capture written off");
      } else {
        await deps.enqueue(
          JOBS.retryCapture,
          { settlementId: req.settlementId },
          { startAfter: RETRY_CAPTURE_AFTER_SECONDS, singletonKey: req.settlementId },
        );
      }
    }
  }

  return {
    /** Every 15 min: due post-paid tabs, prepaid charges to collect, balances to top up. */
    async [JOBS.scan]() {
      for (const tab of await dueTabs(deps.db, deps.cfg, now())) {
        await deps.enqueue(JOBS.capture, { buyerId: tab.buyerId }, { singletonKey: tab.buyerId });
      }
      for (const buyerId of await buyersWithUnsettledPrepaid(deps.db)) {
        await deps.enqueue(JOBS.prepaid, { buyerId }, { singletonKey: buyerId });
      }
      for (const buyerId of await buyersNeedingTopUp(deps.db)) {
        await deps.enqueue(JOBS.topUp, { buyerId }, { singletonKey: buyerId });
      }
    },

    /** One capture of a buyer's whole tab across sellers. Resumes a pending one before opening a new one. */
    async [JOBS.capture]({ buyerId }: { buyerId: string }) {
      const req =
        (await pendingCaptureRequest(deps.db, buyerId)) ??
        (await openCaptureSettlement(deps.db, buyerId));
      if (req) await charge(req);
    },

    async [JOBS.retryCapture]({ settlementId }: { settlementId: string }) {
      const req = await retryCaptureSettlement(deps.db, settlementId);
      if (req) await charge(req);
    },

    async [JOBS.prepaid]({ buyerId }: { buyerId: string }) {
      await settlePrepaid(deps.db, buyerId, deps.cfg, now());
    },

    async [JOBS.topUp]({ buyerId, amountMicros }: { buyerId: string; amountMicros?: number }) {
      const req = await openTopUp(deps.db, buyerId, amountMicros);
      const [mandate] = await deps.db
        .select()
        .from(s.mandates)
        .where(eq(s.mandates.vaultSecretId, req.vaultSecretId ?? ""));
      const result = await deps.funding.capture({
        vaultToken: await vaultToken(deps, mandate?.id ?? "", req.vaultSecretId),
        amountMicros: req.amountMicros,
        reference: req.topUpId,
        description: "Tab402 — prepaid balance top-up",
        lines: [{ description: "Prepaid balance", amountMicros: req.amountMicros }],
        idempotencyKey: req.idempotencyKey,
      });
      deps.log.info(
        { topUpId: req.topUpId, buyerId, result: await recordTopUp(deps.db, req.topUpId, result) },
        "top-up",
      );
    },

    /** Weekly payouts (all payable sellers) and daily threshold payouts (≥ $20). */
    async [JOBS.payoutRun]({ kind }: { kind: "weekly" | "threshold" }) {
      const date = now().toISOString().slice(0, 10); // UTC, so retries derive the same run key
      const min = kind === "weekly" ? 0 : deps.cfg.payoutThresholdMicros;
      const plan = await openPayoutRun(deps.db, `${kind === "weekly" ? "w" : "d"}-${date}`, min);
      if (!plan) return;
      if (!plan.providerBatchId) {
        // INSUFFICIENT_FUNDS and other errors throw → pg-boss retries with backoff; the batch id is stable.
        const { batchId } = await deps.payouts.payout(
          plan.senderBatchId,
          plan.items.map((i) => ({
            itemId: i.itemId,
            receiver: i.receiver,
            amountMicros: i.amountMicros,
          })),
        );
        await recordPayoutSubmitted(deps.db, plan.payoutId, batchId);
        deps.log.info(
          { payoutId: plan.payoutId, batchId, items: plan.items.length },
          "payout submitted",
        );
      }
      await deps.enqueue(
        JOBS.payoutPoll,
        { payoutId: plan.payoutId, attempt: 1 },
        { startAfter: 30 },
      );
    },

    async [JOBS.payoutPoll]({ payoutId, attempt }: { payoutId: string; attempt: number }) {
      const [payout] = await deps.db.select().from(s.payouts).where(eq(s.payouts.id, payoutId));
      if (!payout?.paypalPayoutBatchId) return;
      const batch = await deps.payouts.getBatch(payout.paypalPayoutBatchId);
      const { status } = await recordPayoutResults(deps.db, payoutId, batch.items, now());
      if (status === "processing" && attempt < MAX_PAYOUT_POLLS) {
        await deps.enqueue(
          JOBS.payoutPoll,
          { payoutId, attempt: attempt + 1 },
          { startAfter: POLL_PAYOUT_EVERY_SECONDS },
        );
      }
    },

    /** Signed merchant webhooks with exponential backoff for up to 24 h. */
    async [JOBS.deliverEvents]() {
      const due = await deps.db
        .select({ event: s.eventsOut, url: s.sellers.webhookUrl })
        .from(s.eventsOut)
        .innerJoin(s.sellers, eq(s.sellers.id, s.eventsOut.sellerId))
        .where(
          and(
            eq(s.eventsOut.deliveryStatus, "pending"),
            lte(s.eventsOut.nextAttemptAt, now()),
            isNotNull(s.sellers.webhookUrl),
          ),
        )
        .orderBy(s.eventsOut.createdAt)
        .limit(100);
      const secrets = new Map<string, string | null>();
      for (const { event, url } of due) {
        if (!secrets.has(event.sellerId)) {
          const [secret] = await deps.db
            .select()
            .from(s.merchantSecrets)
            .where(
              and(
                eq(s.merchantSecrets.ownerId, event.sellerId),
                eq(s.merchantSecrets.kind, "webhook_signing_secret"),
              ),
            );
          secrets.set(
            event.sellerId,
            secret ? openSecret(deps.masterKey, secret.ownerId, secret.kind, secret.blob) : null,
          );
        }
        const secret = secrets.get(event.sellerId);
        if (!secret || !url) continue;

        const body = JSON.stringify(event.payload);
        let ok = false;
        let error = "";
        try {
          const res = await (deps.fetch ?? fetch)(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(
                secret,
                body,
                Math.floor(now().getTime() / 1000),
              ),
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          ok = res.ok;
          if (!ok) error = `HTTP ${res.status}`;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const attempts = event.attempts + 1;
        const expired = now().getTime() - event.createdAt.getTime() >= EVENT_MAX_AGE_MS;
        await deps.db
          .update(s.eventsOut)
          .set(
            ok
              ? { deliveryStatus: "delivered", attempts, lastError: null }
              : {
                  deliveryStatus: expired ? "failed" : "pending",
                  attempts,
                  lastError: error.slice(0, 500),
                  nextAttemptAt: new Date(
                    now().getTime() + Math.min(30_000 * 2 ** (attempts - 1), 2 * 3600_000),
                  ),
                },
          )
          .where(eq(s.eventsOut.id, event.id));
      }
    },

    /** Apply a verified PayPal webhook (stored by the API, deduplicated by event id). */
    async [JOBS.paypalWebhook]({ eventId }: { eventId: string }) {
      const [row] = await deps.db
        .select()
        .from(s.webhookEventsIn)
        .where(and(eq(s.webhookEventsIn.id, eventId), isNull(s.webhookEventsIn.processedAt)));
      if (!row) return;
      await applyPayPalEvent(deps, row.payload as PayPalWebhookEvent, now());
      await deps.db
        .update(s.webhookEventsIn)
        .set({ processedAt: now() })
        .where(eq(s.webhookEventsIn.id, eventId));
    },

    /** Hourly: captures still unconfirmed after an hour are checked against PayPal. */
    /** Push notifications from the outbox (approvals, payouts, failed captures), plus approval emails. */
    async [JOBS.pushSend]() {
      if (deps.email) {
        const { sender, webUrl, secret } = deps.email;
        const r = await deliverApprovalEmails(deps.db, sender, { webUrl, secret, now });
        if (r.sent || r.failed) deps.log.info(r, "approval emails delivered");
      }
      if (!deps.push) return;
      for (let i = 0; i < 10; i++) {
        const r = await deliverNotifications(deps.db, deps.push, { now });
        if (r.sent || r.failed) deps.log.info(r, "push notifications delivered");
        if (r.sent + r.failed < 100) return;
      }
    },

    async [JOBS.reconcile]() {
      for (const st of await unreconciledSettlements(deps.db, 3600_000, now())) {
        if (!st.orderId) continue;
        const order = await deps.funding.getOrder(st.orderId);
        if (order.captureStatus === "COMPLETED") await markSettlementMatched(deps.db, st.id);
        else {
          await markSettlementRejected(deps.db, st.id);
          deps.log.error({ settlementId: st.id, order }, "reconciliation mismatch");
        }
      }
    },
  } satisfies Record<JobName, (data: never) => Promise<void>>;
}

const PAYOUT_EVENT_STATUS: Record<string, ProviderItemStatus> = {
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "success",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "failed",
  "PAYMENT.PAYOUTS-ITEM.DENIED": "failed",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "returned",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "blocked",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": "refunded",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "unclaimed",
  "PAYMENT.PAYOUTS-ITEM.HELD": "pending",
};

/** The fields Tab402 reads from capture and payout-item webhook resources. */
interface PayPalEventResource {
  id?: string;
  custom_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  seller_receivable_breakdown?: { paypal_fee?: { value?: string } };
  payout_item_id?: string;
  payout_item?: { sender_item_id?: string };
  payout_item_fee?: { value?: string };
}

export async function applyPayPalEvent(
  deps: WorkerDeps,
  event: PayPalWebhookEvent,
  now: Date,
): Promise<void> {
  const r = event.resource as PayPalEventResource;
  const ref = r.custom_id ?? "";
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      const fee = r.seller_receivable_breakdown?.paypal_fee?.value;
      const outcome = {
        status: "captured" as const,
        orderId: r.supplementary_data?.related_ids?.order_id ?? "",
        captureId: r.id ?? null,
        feeMicros: fee ? payPalToMicros(fee) : 0,
      };
      if (ref.startsWith("stl_")) {
        await recordCaptureResult(deps.db, ref, outcome, deps.cfg, now);
        await markSettlementMatched(deps.db, ref);
      } else if (ref.startsWith("top_")) await recordTopUp(deps.db, ref, outcome);
      return;
    }
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      const outcome = {
        status: "declined" as const,
        orderId: r.supplementary_data?.related_ids?.order_id ?? null,
        reason: event.event_type,
      };
      if (ref.startsWith("stl_")) await recordCaptureResult(deps.db, ref, outcome, deps.cfg, now);
      else if (ref.startsWith("top_")) await recordTopUp(deps.db, ref, outcome);
      return;
    }
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      if (ref.startsWith("stl_")) await markSettlementDisputed(deps.db, ref, event.event_type, now);
      return;
    }
    default: {
      const status = PAYOUT_EVENT_STATUS[event.event_type];
      const itemId: string | undefined = r.payout_item?.sender_item_id;
      if (!status || !itemId) return;
      const [item] = await deps.db.select().from(s.payoutItems).where(eq(s.payoutItems.id, itemId));
      if (!item) return;
      await recordPayoutResults(
        deps.db,
        item.payoutId,
        [
          {
            itemId,
            providerItemId: r.payout_item_id ?? null,
            status,
            feeMicros: r.payout_item_fee?.value ? payPalToMicros(r.payout_item_fee.value) : 0,
          },
        ],
        now,
      );
    }
  }
}

/** Cron schedules (UTC). */
export const SCHEDULES: { name: JobName; cron: string; data?: object; key?: string }[] = [
  { name: JOBS.scan, cron: "*/15 * * * *" },
  { name: JOBS.payoutRun, cron: "0 0 * * 1", data: { kind: "weekly" }, key: "weekly" },
  { name: JOBS.payoutRun, cron: "0 1 * * *", data: { kind: "threshold" }, key: "threshold" },
  { name: JOBS.deliverEvents, cron: "* * * * *" },
  { name: JOBS.reconcile, cron: "7 * * * *" },
  // Safety net: the worker also LISTENs on tab402_notify and sends within moments.
  { name: JOBS.pushSend, cron: "* * * * *" },
];

export { JOBS };
