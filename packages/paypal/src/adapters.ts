/** Provider-neutral adapter interfaces. The ledger only talks to these. */

export interface ReceiptLine {
  description: string;
  amountMicros: number;
}

export type CaptureResult =
  | {
      status: "captured" | "pending";
      orderId: string;
      captureId: string | null;
      grossMicros: number;
      /** Processor fee reported by the provider; 0 if not yet known (pending). */
      feeMicros: number;
    }
  | { status: "declined"; orderId: string | null; reason: string };

export interface FundingAdapter {
  /** Start saving a payment method without a purchase; the buyer approves at `approveUrl`. */
  beginMandate(input: {
    returnUrl: string;
    cancelUrl: string;
    description: string;
  }): Promise<{ setupToken: string; approveUrl: string }>;
  /** Exchange an approved setup token for a long-lived vault token. */
  completeMandate(
    setupToken: string,
  ): Promise<{ vaultToken: string; payerEmail?: string; customerId?: string }>;
  /** Merchant-initiated charge on the saved method (buyer not present). `amountMicros` must be whole cents. */
  capture(input: {
    vaultToken: string;
    amountMicros: number;
    reference: string;
    description: string;
    lines: ReceiptLine[];
    idempotencyKey: string;
  }): Promise<CaptureResult>;
  /** Look up an order for reconciliation. */
  getOrder(orderId: string): Promise<{ status: string; captureStatus: string | null }>;
}

export interface PayoutItemInput {
  /** Our payout item id; echoed back as sender_item_id. */
  itemId: string;
  receiver: string;
  amountMicros: number;
  note?: string;
}

export type PayoutItemStatus =
  | "pending"
  | "success"
  | "failed"
  | "unclaimed"
  | "returned"
  | "blocked"
  | "refunded";

export interface PayoutBatchResult {
  batchId: string;
  status: "pending" | "processing" | "success" | "denied" | "canceled";
  items: {
    itemId: string;
    providerItemId: string | null;
    status: PayoutItemStatus;
    feeMicros: number;
  }[];
}

export interface PayoutAdapter {
  /** Submit one batch with one item per seller. `senderBatchId` must be stable for retries. */
  payout(senderBatchId: string, items: PayoutItemInput[]): Promise<{ batchId: string }>;
  getBatch(batchId: string): Promise<PayoutBatchResult>;
}
