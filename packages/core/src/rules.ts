import { isMicros, parseMicros } from "./money";
import {
  isTabRequirements,
  type PricingMode,
  type TabPaymentPayload,
  type TabVoucherPayload,
  VOUCHER_MAX_TTL_SECONDS,
  X402_VERSION,
} from "./scheme";

/** Reasons the gate rejects a voucher. Returned as x402 `invalidReason`. */
export const VOUCHER_REJECTIONS = [
  "malformed_payload",
  "invalid_signature",
  "quote_mismatch",
  "quote_used",
  "quote_expired",
  "seq_mismatch",
  "voucher_expired",
  "voucher_expiry_too_far",
  "insufficient_cumulative",
] as const;
export type VoucherRejection = (typeof VOUCHER_REJECTIONS)[number];

/**
 * Every reason the facilitator can reject a payment: the pure voucher rules above, plus checks
 * that need server state (keys, quotes, channels, funding). Returned as x402 `invalidReason`.
 */
export const PAYMENT_REJECTIONS = [
  "malformed_payload",
  "invalid_signature",
  "quote_mismatch",
  "quote_used",
  "quote_expired",
  "seq_mismatch",
  "voucher_expired",
  "voucher_expiry_too_far",
  "insufficient_cumulative",
  "unknown_key",
  "key_inactive",
  "unknown_quote",
  "wrong_seller",
  "channel_mismatch",
  "no_mandate",
  "balance_empty",
  "tab_limit",
  "guard_denied",
  "approval_required",
] as const;
export type PaymentRejection = (typeof PAYMENT_REJECTIONS)[number];

/** Channel state the facilitator returns on seq/channel rejections so a client can resync. */
export interface ChannelState {
  channelId: string;
  lastSeq: number;
  /** Recorded total, micro-USD wire string. The next voucher builds on this. */
  cumulative: string;
}

export type RuleResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? unknown : { value: T }))
  | { ok: false; reason: VoucherRejection; message: string };

function reject(
  reason: VoucherRejection,
  message: string,
): { ok: false; reason: VoucherRejection; message: string } {
  return { ok: false, reason, message };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural check of an incoming x402 payload for the `tab` scheme. No crypto, no DB. */
export function parseTabPaymentPayload(value: unknown): RuleResult<TabPaymentPayload> {
  if (typeof value !== "object" || value === null)
    return reject("malformed_payload", "payload is not an object");
  const p = value as Partial<TabPaymentPayload>;
  if (p.x402Version !== X402_VERSION) return reject("malformed_payload", "x402Version must be 2");
  if (!p.accepted || !isTabRequirements(p.accepted)) {
    return reject("malformed_payload", "accepted is not a tab requirements entry");
  }
  const v = p.payload as Partial<TabVoucherPayload> | undefined;
  if (
    !v ||
    !isNonEmptyString(v.channelId) ||
    !isNonEmptyString(v.keyId) ||
    !isNonEmptyString(v.quoteId) ||
    !isNonEmptyString(v.signature) ||
    !Number.isSafeInteger(v.seq) ||
    (v.seq as number) < 1 ||
    !Number.isSafeInteger(v.expiresAt) ||
    typeof v.cumulative !== "string"
  ) {
    return reject("malformed_payload", "voucher fields missing or wrong type");
  }
  try {
    parseMicros(v.cumulative);
  } catch {
    return reject("malformed_payload", "cumulative is not a micro-unit amount");
  }
  if (v.quoteId !== p.accepted.extra.quoteId) {
    return reject("quote_mismatch", "voucher quoteId differs from accepted.extra.quoteId");
  }
  return { ok: true, value: p as TabPaymentPayload };
}

/** Server-side state needed to judge one voucher. */
export interface VoucherCheckInput {
  voucher: TabVoucherPayload;
  /** Current channel state; `null` when this is the first voucher on a new channel. */
  channel: { lastSeq: number; cumulativeRecorded: number } | null;
  quote: {
    id: string;
    /** Fixed price, or maximum for metered. */
    amountMicros: number;
    pricing: PricingMode;
    /** Unix seconds. */
    expiresAt: number;
    used: boolean;
  };
  /** Unix seconds. */
  now: number;
}

export interface VoucherCheckOk {
  cumulative: number;
  /** Amount this voucher authorizes on top of the recorded total. */
  authorized: number;
}

/**
 * Replay and amount rules. Signature verification is separate
 * (needs the registered public key); call it first.
 */
export function checkVoucherRules(input: VoucherCheckInput): RuleResult<VoucherCheckOk> {
  const { voucher, channel, quote, now } = input;

  if (voucher.quoteId !== quote.id)
    return reject("quote_mismatch", "voucher is for a different quote");
  if (quote.used) return reject("quote_used", "quote has already been paid");
  if (quote.expiresAt <= now) return reject("quote_expired", "quote has expired");

  if (voucher.expiresAt <= now) return reject("voucher_expired", "voucher has expired");
  if (voucher.expiresAt > now + VOUCHER_MAX_TTL_SECONDS) {
    return reject(
      "voucher_expiry_too_far",
      `voucher expiry must be within ${VOUCHER_MAX_TTL_SECONDS}s`,
    );
  }

  const lastSeq = channel?.lastSeq ?? 0;
  if (voucher.seq !== lastSeq + 1) {
    return reject("seq_mismatch", `expected seq ${lastSeq + 1}, got ${voucher.seq}`);
  }

  if (!isMicros(quote.amountMicros)) return reject("malformed_payload", "quote amount invalid");
  const recorded = channel?.cumulativeRecorded ?? 0;
  const cumulative = parseMicros(voucher.cumulative);
  const required = recorded + quote.amountMicros;
  if (cumulative < required) {
    return reject(
      "insufficient_cumulative",
      `cumulative must be at least ${required}, got ${cumulative}`,
    );
  }

  return { ok: true, value: { cumulative, authorized: cumulative - recorded } };
}

/**
 * For metered pricing: the gate records the actual cost, never more than authorized
 * or the quoted maximum. Settlement always uses recorded actuals.
 */
export function meteredCharge(
  actualMicros: number,
  quoteMaxMicros: number,
  authorizedMicros: number,
): number {
  if (!isMicros(actualMicros))
    throw new RangeError("actual cost must be non-negative integer micros");
  return Math.min(actualMicros, quoteMaxMicros, authorizedMicros);
}
