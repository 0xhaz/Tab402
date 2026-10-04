import { newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import type { Executor } from "./types";

/** Merchant event types. */
export type MerchantEventType =
  | "charge.recorded"
  | "charge.refunded"
  | "tab.settled"
  | "tab.capture_failed"
  | "buyer.budget_exceeded"
  | "access.granted"
  | "payout.sent"
  | "payout.failed"
  | "dispute.opened";

export const API_VERSION = "2026-10-01";

/** The envelope for one event. Exported so hot paths can insert it inside a combined statement. */
export function buildEvent(
  type: MerchantEventType,
  data: Record<string, unknown>,
  now: Date = new Date(),
): {
  id: string;
  payload: {
    id: string;
    type: MerchantEventType;
    created: number;
    api_version: string;
    data: Record<string, unknown>;
  };
} {
  const id = newId("eventOut");
  return {
    id,
    payload: {
      id,
      type,
      created: Math.floor(now.getTime() / 1000),
      api_version: API_VERSION,
      data,
    },
  };
}

/** Queue an outbound merchant event. Delivery (signed POST + retries) is the worker's job. */
export async function recordEvent(
  tx: Executor,
  sellerId: string,
  type: MerchantEventType,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<string> {
  const id = newId("eventOut");
  await tx.insert(s.eventsOut).values({
    id,
    sellerId,
    type,
    payload: {
      id,
      type,
      created: Math.floor(now.getTime() / 1000),
      api_version: API_VERSION,
      data,
    },
    nextAttemptAt: now,
    createdAt: now,
  });
  return id;
}
