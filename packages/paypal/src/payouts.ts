import type {
  PayoutAdapter,
  PayoutBatchResult,
  PayoutItemInput,
  PayoutItemStatus,
} from "./adapters";
import type { PayPalClient } from "./client";
import { microsToPayPal, payPalToMicros } from "./money";

const ITEM_STATUS: Record<string, PayoutItemStatus> = {
  SUCCESS: "success",
  PENDING: "pending",
  ONHOLD: "pending",
  NEW: "pending",
  FAILED: "failed",
  DENIED: "failed",
  UNCLAIMED: "unclaimed",
  RETURNED: "returned",
  BLOCKED: "blocked",
  REFUNDED: "refunded",
  REVERSED: "returned",
};

const BATCH_STATUS: Record<string, PayoutBatchResult["status"]> = {
  PENDING: "pending",
  PROCESSING: "processing",
  SUCCESS: "success",
  DENIED: "denied",
  CANCELED: "canceled",
};

/** PayPal Payouts v1 — one batch per run, one item per seller. */
export class PayPalPayouts implements PayoutAdapter {
  constructor(private readonly client: PayPalClient) {}

  async payout(senderBatchId: string, items: PayoutItemInput[]) {
    const r = await this.client.request<{ batch_header: { payout_batch_id: string } }>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          recipient_type: "EMAIL",
          email_subject: "You have a Tab402 payout",
          email_message: "Your Tab402 earnings.",
        },
        items: items.map((i) => ({
          recipient_type: "EMAIL",
          receiver: i.receiver,
          amount: { currency: "USD", value: microsToPayPal(i.amountMicros) },
          note: i.note ?? "Tab402 payout",
          sender_item_id: i.itemId,
        })),
      },
      { idempotencyKey: senderBatchId },
    );
    return { batchId: r.batch_header.payout_batch_id };
  }

  async getBatch(batchId: string): Promise<PayoutBatchResult> {
    const r = await this.client.request<{
      batch_header: { payout_batch_id: string; batch_status: string };
      items?: {
        payout_item_id: string;
        transaction_status: string;
        payout_item_fee?: { value: string };
        payout_item: { sender_item_id: string };
      }[];
    }>("GET", `/v1/payments/payouts/${batchId}`);
    return {
      batchId: r.batch_header.payout_batch_id,
      status: BATCH_STATUS[r.batch_header.batch_status] ?? "processing",
      items: (r.items ?? []).map((i) => ({
        itemId: i.payout_item.sender_item_id,
        providerItemId: i.payout_item_id,
        status: ITEM_STATUS[i.transaction_status] ?? "pending",
        feeMicros: i.payout_item_fee ? payPalToMicros(i.payout_item_fee.value) : 0,
      })),
    };
  }
}
