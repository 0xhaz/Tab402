import {
  AGENT_SIGNATURE_HEADER,
  type ChannelState,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  HEADERS,
  isTabRequirements,
  newId,
  type PaymentRequired,
  type PricingMode,
  parseMicros,
  signAgentRequest,
  signVoucher,
  type TabRequirements,
  type TabSettleExtra,
} from "@tab402/core";
import { type ChannelStore, MemoryChannelStore } from "./store";

/** What the guard sees before any voucher is signed. Price always comes from the seller's quote. */
export interface Quote {
  url: string;
  method: string;
  sellerId: string;
  quoteId: string;
  pricing: PricingMode;
  /** Price for fixed; maximum for metered. */
  amountMicros: number;
  description?: string;
}

export type GuardDecision = { outcome: "approve" } | { outcome: "deny" | "ask"; reason: string };
/** Optional local check before signing. Tab402's server-side spend guard always runs as well. */
export type Guard = (quote: Quote) => Promise<GuardDecision> | GuardDecision;

/** Per-call options (the third argument to `client.fetch`). */
export interface PayOptions {
  /** One line on what the purchase is for; the spend guard checks quotes against it. */
  intent?: string;
  /** Refuse quotes above this, before signing anything. */
  maxPriceMicros?: number;
}

/** A purchase waiting for the buyer's OK (amount above the approval threshold, or the model asked). */
export interface ApprovalRequired {
  id: string;
  url: string | null;
  expiresAt: string;
}

interface ServerDecision {
  outcome: "approve" | "deny" | "ask";
  reason: string;
  approval?: ApprovalRequired;
}

export interface Receipt {
  chargeId: string;
  sellerId: string;
  url: string;
  chargedMicros: number;
  quote: Quote;
}

export interface Tab402ClientOptions {
  keyId: string;
  privateKey: CryptoKey;
  /** Spend guard; runs before any voucher is signed. Defaults to approve-all (dev only). */
  guard?: Guard;
  store?: ChannelStore;
  fetch?: typeof fetch;
  onPayment?: (receipt: Receipt) => void;
  /** Voucher lifetime in seconds (≤ 300). */
  voucherTtlSeconds?: number;
  now?: () => number;
}

export class PaymentError extends Error {
  override name = "PaymentError";
  constructor(
    /** e.g. guard_denied, approval_required, over_max_price, balance_empty, tab_limit, key_inactive */
    readonly reason: string,
    message: string,
    readonly quote?: Quote,
    /** Set when reason is approval_required: send the buyer here, then retry the call. */
    readonly approval?: ApprovalRequired,
  ) {
    super(message);
  }
}

const approveAll: Guard = () => ({ outcome: "approve" });

/**
 * fetch wrapper: request → 402 → guard → signed cumulative voucher → retry.
 * One in-flight payment per seller channel, so seq stays strictly ordered under concurrency.
 */
export class Tab402Client {
  private readonly store: ChannelStore;
  private readonly fetchImpl: typeof fetch;
  private readonly guard: Guard;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: Tab402ClientOptions) {
    this.store = options.store ?? new MemoryChannelStore();
    this.fetchImpl = options.fetch ?? fetch;
    this.guard = options.guard ?? approveAll;
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    opts: PayOptions = {},
  ): Promise<Response> => {
    const request = new Request(input, init);
    const first = await this.fetchImpl(request.clone());
    if (first.status !== 402) return first;

    const required = readRequired(first);
    const requirements = required?.accepts.find(isTabRequirements);
    if (!required || !requirements) return first; // Not payable with a Tab402 tab.

    const quote = toQuote(request, requirements, required);
    if (opts.maxPriceMicros !== undefined && quote.amountMicros > opts.maxPriceMicros) {
      throw new PaymentError(
        "over_max_price",
        `quote ${quote.amountMicros} is above max_price ${opts.maxPriceMicros}`,
        quote,
      );
    }
    const decision = await this.guard(quote);
    if (decision.outcome !== "approve") {
      throw new PaymentError(
        decision.outcome === "deny" ? "guard_denied" : "approval_required",
        decision.reason,
        quote,
      );
    }

    return this.withLock(quote.sellerId, () =>
      this.pay(request, requirements, quote, { resync: true, guard: true }, opts),
    );
  };

  /** Ask Tab402's spend guard about a quote (agent-signed request). */
  private async decide(
    requirements: TabRequirements,
    intent: string | undefined,
  ): Promise<ServerDecision> {
    const body = JSON.stringify({ quoteId: requirements.extra.quoteId, intent });
    const t = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const res = await this.fetchImpl(
      `${requirements.extra.facilitator.replace(/\/+$/, "")}/guard/decide`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AGENT_SIGNATURE_HEADER]: await signAgentRequest(
            this.options.privateKey,
            this.options.keyId,
            body,
            t,
          ),
        },
        body,
      },
    );
    if (!res.ok) throw new PaymentError("guard_unavailable", `spend guard returned ${res.status}`);
    return (await res.json()) as ServerDecision;
  }

  private async pay(
    request: Request,
    requirements: TabRequirements,
    quote: Quote,
    retries: { resync: boolean; guard: boolean },
    opts: PayOptions,
  ): Promise<Response> {
    const state = await this.store.get(quote.sellerId);
    const nowSec = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const recorded = state ? parseMicros(state.cumulative) : 0;
    const voucher = await signVoucher(
      {
        channelId: state?.channelId ?? newId("channel"),
        keyId: this.options.keyId,
        seq: (state?.lastSeq ?? 0) + 1,
        cumulative: String(recorded + quote.amountMicros),
        quoteId: quote.quoteId,
        expiresAt: nowSec + Math.min(this.options.voucherTtlSeconds ?? 120, 300),
      },
      this.options.privateKey,
    );

    const headers = new Headers(request.headers);
    headers.set(
      HEADERS.paymentSignature,
      encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: requirements,
        payload: { ...voucher },
      }),
    );
    const res = await this.fetchImpl(new Request(request.clone(), { headers }));

    if (res.status === 402) {
      const again = readRequired(res);
      const next = again?.accepts.find(isTabRequirements);
      const channel = next?.extra.channel as ChannelState | undefined;
      const reason = again?.error ?? "payment_rejected";
      if (retries.resync && next && (channel || reason === "seq_mismatch")) {
        // Our local channel state was stale; adopt the server's and pay the fresh quote once.
        if (channel) await this.store.set(quote.sellerId, channel);
        return this.pay(
          request,
          next,
          { ...quote, quoteId: next.extra.quoteId },
          { ...retries, resync: false },
          opts,
        );
      }
      if (retries.guard && next && reason === "approval_required") {
        // Not routine for this buyer: ask the spend guard about the fresh quote, with our intent.
        const d = await this.decide(next, opts.intent);
        const fresh = { ...quote, quoteId: next.extra.quoteId };
        if (d.outcome === "approve")
          return this.pay(request, next, fresh, { ...retries, guard: false }, opts);
        if (d.outcome === "deny") throw new PaymentError("guard_denied", d.reason, fresh);
        throw new PaymentError("approval_required", d.reason, fresh, d.approval);
      }
      if (next && reason === "guard_denied") {
        // /verify only carries the code. Ask the guard which rule it was, so the agent can say why.
        const d = await this.decide(next, opts.intent).catch(() => null);
        if (d?.outcome === "deny")
          throw new PaymentError("guard_denied", d.reason, {
            ...quote,
            quoteId: next.extra.quoteId,
          });
      }
      throw new PaymentError(reason, `payment rejected: ${reason}`, quote);
    }

    const header = res.headers.get(HEADERS.paymentResponse);
    if (header) {
      const settled = decodePaymentResponseHeader(header);
      const extra = settled.extra as TabSettleExtra | undefined;
      if (settled.success && extra) {
        await this.store.set(quote.sellerId, {
          channelId: extra.channelId,
          lastSeq: extra.seq,
          cumulative: extra.cumulative,
        });
        this.options.onPayment?.({
          chargeId: extra.chargeId,
          sellerId: quote.sellerId,
          url: quote.url,
          chargedMicros: parseMicros(extra.charged),
          quote,
        });
      }
    }
    return res;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function readRequired(res: Response): PaymentRequired | undefined {
  const header = res.headers.get(HEADERS.paymentRequired);
  if (!header) return undefined;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return undefined;
  }
}

function toQuote(request: Request, req: TabRequirements, required: PaymentRequired): Quote {
  return {
    url: required.resource?.url ?? request.url,
    method: request.method,
    sellerId: req.payTo,
    quoteId: req.extra.quoteId,
    pricing: req.extra.pricing,
    amountMicros: parseMicros(req.amount),
    description: required.resource?.description,
  };
}
