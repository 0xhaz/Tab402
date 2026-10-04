import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { microsToWire } from "./money";

/** The Tab402 fiat-tab scheme, carried as one more entry in x402 v2 `accepts`. */
export const X402_VERSION = 2;
export const TAB_SCHEME = "tab";
export const TAB_ASSET = "USD";
export const TAB_DECIMALS = 6;
export const TAB_NETWORKS = { sandbox: "tab402:sandbox", live: "tab402:live" } as const;
export type TabNetwork = (typeof TAB_NETWORKS)[keyof typeof TAB_NETWORKS];

/** Vouchers expire 5 minutes after signing at most. */
export const VOUCHER_MAX_TTL_SECONDS = 300;

export const PRICING_MODES = ["fixed", "metered", "per_request_domain", "tiered"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export interface TabRequirementsExtra {
  decimals: typeof TAB_DECIMALS;
  pricing: PricingMode;
  quoteId: string;
  facilitator: string;
  /** Present on a re-quote after a seq/channel rejection: the server's channel state to resync from. */
  channel?: { channelId: string; lastSeq: number; cumulative: string };
  [key: string]: unknown;
}

export interface TabRequirements extends PaymentRequirements {
  scheme: typeof TAB_SCHEME;
  network: TabNetwork;
  asset: typeof TAB_ASSET;
  extra: TabRequirementsExtra;
}

export interface BuildTabRequirementsInput {
  network: TabNetwork;
  /** Price for `fixed`; maximum authorization for `metered`. */
  amountMicros: number;
  sellerId: string;
  quoteId: string;
  pricing: PricingMode;
  facilitatorUrl: string;
  maxTimeoutSeconds?: number;
}

export function buildTabRequirements(input: BuildTabRequirementsInput): TabRequirements {
  return {
    scheme: TAB_SCHEME,
    network: input.network,
    amount: microsToWire(input.amountMicros),
    asset: TAB_ASSET,
    payTo: input.sellerId,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? VOUCHER_MAX_TTL_SECONDS,
    extra: {
      decimals: TAB_DECIMALS,
      pricing: input.pricing,
      quoteId: input.quoteId,
      facilitator: input.facilitatorUrl,
    },
  };
}

export function isTabNetwork(network: Network | string): network is TabNetwork {
  return network === TAB_NETWORKS.sandbox || network === TAB_NETWORKS.live;
}

export function isTabRequirements(req: PaymentRequirements): req is TabRequirements {
  const extra = req.extra as Partial<TabRequirementsExtra> | undefined;
  return (
    req.scheme === TAB_SCHEME &&
    isTabNetwork(req.network) &&
    req.asset === TAB_ASSET &&
    extra?.decimals === TAB_DECIMALS &&
    typeof extra.quoteId === "string" &&
    typeof extra.pricing === "string" &&
    (PRICING_MODES as readonly string[]).includes(extra.pricing)
  );
}

/** The fields an ES256 signature covers. */
export interface TabVoucherFields {
  channelId: string;
  keyId: string;
  /** Exactly last + 1 per channel; the first voucher on a channel is 1. */
  seq: number;
  /** Running total authorized on the channel, micro-USD as a wire string. */
  cumulative: string;
  quoteId: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface TabVoucherPayload extends TabVoucherFields {
  /** base64url ES256 signature (IEEE P1363 r||s) over RFC 8785 canonical JSON of the fields. */
  signature: string;
}

export interface TabPaymentPayload extends PaymentPayload {
  accepted: TabRequirements;
  payload: TabVoucherPayload & Record<string, unknown>;
}

/** Tab402 fields returned in `PAYMENT-RESPONSE.extra`. */
export interface TabSettleExtra {
  chargeId: string;
  channelId: string;
  /** Amount actually recorded for this call (≤ authorized for metered). */
  charged: string;
  /** New recorded channel total — the next voucher builds on this. */
  cumulative: string;
  seq: number;
  [key: string]: unknown;
}
