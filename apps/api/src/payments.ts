import {
  type ChannelState,
  checkVoucherRules,
  meteredCharge,
  newId,
  type PaymentRejection,
  type PaymentRequirements,
  parseMicros,
  parseTabPaymentPayload,
  type SettleResponse,
  type TabPaymentPayload,
  type TabSettleExtra,
  type VerifyResponse,
} from "@tab402/core";
import { type Database, schema as s } from "@tab402/db";
import { checkAtVerify, consumeApproval, type VerifyGuardResult } from "@tab402/guard";
import { buildEvent, JOBS } from "@tab402/ledger";
import { and, eq, sql } from "drizzle-orm";
import { type Deps, guardDeps } from "./context";
import type { CachedAgentKey } from "./key-cache";
import { verifyVoucherNative } from "./signature";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export class PaymentRejected extends Error {
  constructor(
    readonly reason: PaymentRejection,
    message: string,
    readonly channel?: ChannelState,
  ) {
    super(message);
  }
}

interface Checked {
  payload: TabPaymentPayload;
  key: CachedAgentKey;
  quote: typeof s.quotes.$inferSelect;
  channel: typeof s.channels.$inferSelect | undefined;
  mandate: typeof s.mandates.$inferSelect;
  balance: typeof s.balances.$inferSelect | null;
  cumulative: number;
  authorized: number;
}

function channelState(ch: typeof s.channels.$inferSelect): ChannelState {
  return { channelId: ch.id, lastSeq: ch.lastSeq, cumulative: String(ch.cumulativeRecordedMicros) };
}

/**
 * Every check a payment must pass. Reads quote, channel, mandate and
 * balance in one round trip. `settle` doesn't lock these rows: its writes are conditional on the
 * state checked here (quote still issued, channel seq unchanged, balance sufficient), so a racing
 * request makes a write miss and the transaction rolls back.
 */
async function check(
  deps: Deps,
  tx: Executor,
  sellerId: string,
  rawPayload: unknown,
  requirements: PaymentRequirements,
): Promise<Checked> {
  const parsed = parseTabPaymentPayload(rawPayload);
  if (!parsed.ok) throw new PaymentRejected(parsed.reason, parsed.message);
  const payload = parsed.value;
  const voucher = payload.payload;

  if (payload.accepted.payTo !== sellerId || requirements.payTo !== sellerId) {
    throw new PaymentRejected("wrong_seller", "payment is not addressed to this seller");
  }
  if (
    requirements.extra?.quoteId !== voucher.quoteId ||
    requirements.amount !== payload.accepted.amount
  ) {
    throw new PaymentRejected(
      "quote_mismatch",
      "requirements and payload describe different quotes",
    );
  }

  const key = await deps.keys.get(voucher.keyId);
  if (!key) throw new PaymentRejected("unknown_key", "agent key is not registered");
  const nowMs = deps.now?.() ?? Date.now();
  if (key.status !== "active" || (key.expiresAt && key.expiresAt.getTime() <= nowMs)) {
    throw new PaymentRejected(
      "key_inactive",
      `agent key is ${key.status === "active" ? "expired" : key.status}`,
    );
  }
  if (!verifyVoucherNative(voucher, key.publicKey)) {
    throw new PaymentRejected("invalid_signature", "voucher signature does not verify");
  }

  const [row] = await tx
    .select({ quote: s.quotes, channel: s.channels, mandate: s.mandates, balance: s.balances })
    .from(s.quotes)
    .leftJoin(s.channels, and(eq(s.channels.agentKeyId, key.id), eq(s.channels.sellerId, sellerId)))
    .leftJoin(s.mandates, and(eq(s.mandates.buyerId, key.buyerId), eq(s.mandates.status, "active")))
    .leftJoin(s.balances, eq(s.balances.buyerId, key.buyerId))
    .where(eq(s.quotes.id, voucher.quoteId))
    .limit(1);
  if (!row) throw new PaymentRejected("unknown_quote", "quote not found");
  const { quote, mandate, balance } = row;
  const channel = row.channel ?? undefined;
  if (quote.sellerId !== sellerId)
    throw new PaymentRejected("wrong_seller", "quote belongs to another seller");
  if (String(quote.amountMicros) !== payload.accepted.amount) {
    throw new PaymentRejected("quote_mismatch", "amount differs from the quote");
  }
  if (channel && channel.id !== voucher.channelId) {
    throw new PaymentRejected(
      "channel_mismatch",
      "voucher names a different channel",
      channelState(channel),
    );
  }

  const rules = checkVoucherRules({
    voucher,
    channel: channel
      ? { lastSeq: channel.lastSeq, cumulativeRecorded: channel.cumulativeRecordedMicros }
      : null,
    quote: {
      id: quote.id,
      amountMicros: quote.amountMicros,
      pricing: quote.pricingMode,
      expiresAt: Math.floor(quote.expiresAt.getTime() / 1000),
      used: quote.status !== "issued",
    },
    now: Math.floor(nowMs / 1000),
  });
  if (!rules.ok) {
    const resync = rules.reason === "seq_mismatch" || rules.reason === "insufficient_cumulative";
    throw new PaymentRejected(
      rules.reason,
      rules.message,
      resync && channel ? channelState(channel) : undefined,
    );
  }

  if (!mandate) throw new PaymentRejected("no_mandate", "buyer has no active funding mandate");
  if (mandate.mode === "prepaid") {
    if (!balance || balance.balanceMicros < quote.amountMicros) {
      throw new PaymentRejected("balance_empty", "prepaid balance is too low for this quote");
    }
  } else {
    const [open] = await tx
      .select({ total: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)` })
      .from(s.charges)
      .where(
        and(
          eq(s.charges.buyerId, key.buyerId),
          eq(s.charges.state, "earned"),
          eq(s.charges.prepaid, false),
        ),
      );
    if (Number(open?.total ?? 0) + quote.amountMicros > mandate.creditLimitMicros) {
      // At the cap: capture now rather than waiting for the next scan.
      void deps
        .enqueue?.(JOBS.capture, { buyerId: key.buyerId }, { singletonKey: key.buyerId })
        .catch(() => {});
      throw new PaymentRejected("tab_limit", "open tab would exceed the buyer's cap");
    }
  }

  return {
    payload,
    key,
    quote,
    channel,
    mandate,
    balance,
    cumulative: rules.value.cumulative,
    authorized: rules.value.authorized,
  };
}

/**
 * Guard results from /verify, handed to /settle for the same quote (consume the approval, log the
 * decision). In-process and short-lived; if missing, settle runs the guard itself.
 */
const verifiedGuard = new Map<
  string,
  { result: Extract<VerifyGuardResult, { ok: true }>; expires: number }
>();
function takeVerified(quoteId: string) {
  const hit = verifiedGuard.get(quoteId);
  verifiedGuard.delete(quoteId);
  return hit && hit.expires > Date.now() ? hit.result : undefined;
}
function quoteIdOf(payload: unknown): string | undefined {
  const p = parseTabPaymentPayload(payload);
  return p.ok ? p.value.payload.quoteId : undefined;
}

export async function verifyPayment(
  deps: Deps,
  sellerId: string,
  payload: unknown,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  try {
    // The guard needs only the key and quote from the voucher, so it runs alongside the payment
    // checks (one round trip each, in parallel). A payment-check rejection takes priority.
    const gd = guardDeps(deps);
    const parsed = parseTabPaymentPayload(payload);
    const key = parsed.ok ? await deps.keys.get(parsed.value.payload.keyId) : null;
    const guardRun: Promise<PromiseSettledResult<VerifyGuardResult>> | undefined =
      gd && parsed.ok && key
        ? checkAtVerify(gd, {
            agentKeyId: key.id,
            buyerId: key.buyerId,
            quoteId: parsed.value.payload.quoteId,
          }).then(
            (value) => ({ status: "fulfilled", value }),
            (reason: unknown) => ({ status: "rejected", reason }),
          )
        : undefined;
    let c: Checked;
    try {
      c = await check(deps, deps.db, sellerId, payload, requirements);
    } catch (err) {
      await guardRun; // don't leave the guard query dangling
      throw err;
    }
    if (gd) {
      const settled = guardRun ? await guardRun : undefined;
      if (settled?.status === "rejected") throw settled.reason;
      const g =
        settled?.value ??
        (await checkAtVerify(gd, {
          agentKeyId: c.key.id,
          buyerId: c.key.buyerId,
          quoteId: c.quote.id,
        }));
      if (!g.ok) throw new PaymentRejected(g.reason, `${g.message} (${g.rule})`);
      if (verifiedGuard.size > 10_000) verifiedGuard.clear();
      verifiedGuard.set(c.quote.id, { result: g, expires: Date.now() + 5 * 60_000 });
    }
    return { isValid: true, payer: c.key.id };
  } catch (err) {
    if (!(err instanceof PaymentRejected)) throw err;
    return {
      isValid: false,
      invalidReason: err.reason,
      invalidMessage: err.message,
      ...(err.channel ? { extra: { channel: err.channel } } : {}),
    };
  }
}

/**
 * Record the charge on the tab (not money movement — that happens in batch). For metered
 * pricing the seller reports the actual cost; it is capped at the quote max and the authorization.
 */
export async function settlePayment(
  deps: Deps,
  sellerId: string,
  payload: unknown,
  requirements: PaymentRequirements,
  actualAmount?: string,
): Promise<SettleResponse> {
  const network = deps.config.network;
  let topUpBuyer: string | undefined;

  // The guard must have passed for this quote. A seller that skipped /verify gets it run here.
  let guard: Extract<VerifyGuardResult, { ok: true }> | undefined;
  if (deps.guard) {
    const quoteId = quoteIdOf(payload);
    guard = quoteId ? takeVerified(quoteId) : undefined;
    if (!guard) {
      const v = await verifyPayment(deps, sellerId, payload, requirements);
      if (!v.isValid) {
        return {
          success: false,
          errorReason: v.invalidReason,
          errorMessage: v.invalidMessage,
          transaction: "",
          network,
          ...(v.extra ? { extra: v.extra } : {}),
        };
      }
      guard = quoteId ? takeVerified(quoteId) : undefined;
    }
  }

  try {
    const settled = await deps.db.transaction(async (tx) => {
      const c = await check(deps, tx, sellerId, payload, requirements);
      const voucher = c.payload.payload;

      let charged = c.quote.amountMicros;
      if (c.quote.pricingMode === "metered") {
        if (actualAmount === undefined) {
          throw new PaymentRejected(
            "malformed_payload",
            "metered settle requires the actual amount",
          );
        }
        charged = meteredCharge(parseMicros(actualAmount), c.quote.amountMicros, c.authorized);
      }

      const channelId = voucher.channelId;
      const recordedAfter = (c.channel?.cumulativeRecordedMicros ?? 0) + charged;
      const prepaid = c.mandate.mode === "prepaid";
      const voucherId = newId("voucher");
      const chargeId = newId("charge");
      const decisionId = guard ? newId("guardDecision") : null;
      const at = new Date().toISOString();
      const event = buildEvent("charge.recorded", {
        charge_id: chargeId,
        quote_id: c.quote.id,
        endpoint_id: c.quote.endpointId,
        amount_micros: String(charged),
        authorized_micros: String(c.authorized),
        agent_key_id: c.key.id,
      });

      // Every ledger write for this payment in ONE statement (one round trip). Each write that
      // depends on checked state is conditional: channel seq unchanged, quote still issued, balance
      // sufficient. The result says which held; any miss throws and the transaction rolls back.
      const [r] = await tx.execute<{ ch: number; q: number; bal: string | null }>(sql`
        with ch as (
          insert into channels (id, agent_key_id, seller_id, last_seq, cumulative_authorized_micros, cumulative_recorded_micros, created_at, updated_at)
          values (${channelId}, ${c.key.id}, ${sellerId}, ${voucher.seq}, ${c.cumulative}, ${recordedAfter}, ${at}::timestamptz, ${at}::timestamptz)
          on conflict (id) do update set
            last_seq = excluded.last_seq,
            cumulative_authorized_micros = excluded.cumulative_authorized_micros,
            cumulative_recorded_micros = excluded.cumulative_recorded_micros,
            updated_at = excluded.updated_at
          where channels.last_seq = ${c.channel?.lastSeq ?? -1}
          returning id),
        qu as (
          update quotes set status = 'paid', agent_key_id = ${c.key.id}, resolved_at = ${at}::timestamptz
          where id = ${c.quote.id} and status = 'issued' returning id),
        bal as (
          update balances set balance_micros = balance_micros - ${charged}, updated_at = ${at}::timestamptz
          where ${prepaid} and buyer_id = ${c.key.buyerId} and balance_micros >= ${charged} returning balance_micros),
        v as (
          insert into vouchers (id, channel_id, seq, cumulative_micros, quote_id, expires_at, signature, created_at)
          values (${voucherId}, ${channelId}, ${voucher.seq}, ${c.cumulative}, ${c.quote.id},
                  ${new Date(voucher.expiresAt * 1000).toISOString()}::timestamptz, ${voucher.signature}, ${at}::timestamptz)),
        chg as (
          insert into charges (id, buyer_id, agent_key_id, seller_id, endpoint_id, quote_id, channel_id, voucher_id,
                               amount_micros, authorized_micros, prepaid, state_changed_at, created_at)
          values (${chargeId}, ${c.key.buyerId}, ${c.key.id}, ${sellerId}, ${c.quote.endpointId}, ${c.quote.id}, ${channelId},
                  ${voucherId}, ${charged}, ${c.authorized}, ${prepaid}, ${at}::timestamptz, ${at}::timestamptz)),
        ev as (
          insert into events_out (id, seller_id, type, payload, next_attempt_at, created_at)
          values (${event.id}, ${sellerId}, 'charge.recorded', ${JSON.stringify(event.payload)}::jsonb, ${at}::timestamptz, ${at}::timestamptz)),
        gd as (
          insert into guard_decisions (id, agent_key_id, quote_id, seller_id, endpoint_url, amount_micros, outcome, decided_by, rule, approval_id, created_at)
          select ${decisionId}::text, ${c.key.id}, ${c.quote.id}, ${sellerId}, '', ${c.quote.amountMicros}, 'approve',
                 ${guard?.decidedBy ?? "rule"}::guard_decider, ${guard?.rule ?? null}, ${guard?.approvalId ?? null}, ${at}::timestamptz
          where ${decisionId}::text is not null)
        select (select count(*)::int from ch) as ch, (select count(*)::int from qu) as q, (select balance_micros::text from bal) as bal`);

      if (!r?.ch) throw new PaymentRejected("seq_mismatch", "concurrent voucher on this channel");
      if (!r.q) throw new PaymentRejected("quote_used", "quote has already been paid");
      if (prepaid) {
        if (r.bal === null)
          throw new PaymentRejected("balance_empty", "prepaid balance is too low");
        if (c.balance?.autoTopUp && Number(r.bal) < c.balance.floorMicros)
          topUpBuyer = c.key.buyerId;
      }
      if (guard?.approvalId && !(await consumeApproval(tx, guard.approvalId, chargeId))) {
        throw new PaymentRejected(
          "approval_required",
          "the approval was already used or has expired",
        );
      }

      const extra: TabSettleExtra = {
        chargeId,
        channelId,
        charged: String(charged),
        cumulative: String(recordedAfter),
        seq: voucher.seq,
      };
      return {
        success: true,
        transaction: chargeId,
        network,
        payer: c.key.id,
        amount: String(charged),
        extra,
      };
    });
    if (topUpBuyer) {
      void deps
        .enqueue?.(JOBS.topUp, { buyerId: topUpBuyer }, { singletonKey: topUpBuyer })
        .catch(() => {});
    }
    return settled;
  } catch (err) {
    if (err instanceof PaymentRejected) {
      return {
        success: false,
        errorReason: err.reason,
        errorMessage: err.message,
        transaction: "",
        network,
        ...(err.channel ? { extra: { channel: err.channel } } : {}),
      };
    }
    // A racing payment for the same quote, or a racing first voucher on the same channel.
    if (isUniqueViolation(err) && /quote/.test(constraintOf(err))) {
      return {
        success: false,
        errorReason: "quote_used",
        errorMessage: "quote has already been paid",
        transaction: "",
        network,
      };
    }
    if (isUniqueViolation(err)) {
      return {
        success: false,
        errorReason: "seq_mismatch",
        errorMessage: "concurrent voucher on this channel",
        transaction: "",
        network,
      };
    }
    throw err;
  }
}

function constraintOf(err: unknown): string {
  const cause =
    (err as { cause?: { constraint_name?: string } })?.cause ??
    (err as { constraint_name?: string });
  return cause?.constraint_name ?? "";
}

function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause ?? (err as { code?: string });
  return cause?.code === "23505";
}
