import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Tab402 ledger. Money is integer micro-USD in `bigint` columns, read as JS
 * numbers (safe up to ~$9B). Every money column is suffixed `_micros`.
 */

const micros = (name: string) => bigint(name, { mode: "number" });
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const createdAt = () => now("created_at");
const tsz = (name: string) => timestamp(name, { withTimezone: true });

// ── Enums ──────────────────────────────────────────────────────────────────────

export const keyStatus = pgEnum("key_status", ["active", "frozen", "revoked"]);
export const mandateStatus = pgEnum("mandate_status", ["pending", "active", "frozen", "revoked"]);
export const mandateMode = pgEnum("mandate_mode", ["prepaid", "postpaid"]);
export const rail = pgEnum("rail", ["paypal_wallet", "braintree_card", "invoicing", "pyusd"]);
export const sellerStatus = pgEnum("seller_status", ["active", "suspended"]);
export const pricingMode = pgEnum("pricing_mode", [
  "fixed",
  "metered",
  "per_request_domain",
  "tiered",
]);
export const quoteStatus = pgEnum("quote_status", ["issued", "paid", "denied", "expired"]);
export const guardOutcome = pgEnum("guard_outcome", ["approve", "deny", "ask"]);
export const guardDecider = pgEnum("guard_decider", ["rule", "cache", "model", "human"]);
/** Charge state machine — see `charge-state.ts`. */
export const chargeState = pgEnum("charge_state", [
  "earned",
  "collected",
  "paid_out",
  "refunded",
  "disputed",
  "written_off",
]);
export const reconState = pgEnum("recon_state", [
  "matched",
  "pending",
  "rejected",
  "corrected",
  "written_off",
]);
export const captureStatus = pgEnum("capture_status", [
  "pending",
  "captured",
  "failed",
  "refunded",
]);
export const payoutStatus = pgEnum("payout_status", [
  "pending",
  "processing",
  "success",
  "failed",
  "partial",
]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "delivered", "failed"]);
export const apiKeyOwner = pgEnum("api_key_owner", ["seller", "buyer"]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "used",
]);
export const settlementKind = pgEnum("settlement_kind", ["capture", "prepaid"]);
export const secretKind = pgEnum("secret_kind", [
  "paypal_client_secret",
  "webhook_signing_secret",
  "vault_token",
  /** Private keys of agents whose client is Tab402-hosted (the buyer MCP server). */
  "agent_private_key",
]);

// ── API keys ──────────────────────────────────────────────────────────────────

/** Server-to-server keys (seller gate → facilitator, buyer tooling → key registration). Only hashes stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    ownerType: apiKeyOwner("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    /** First characters, for display ("t402_sk_Ab12…"). */
    prefix: text("prefix").notNull(),
    /** SHA-256 hex of the full key. Keys are 256-bit random, so a fast hash is sufficient. */
    hash: text("hash").notNull(),
    lastUsedAt: tsz("last_used_at"),
    revokedAt: tsz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_idx").on(t.hash),
    index("api_keys_owner_idx").on(t.ownerType, t.ownerId),
  ],
);

// ── Buyers and agents ─────────────────────────────────────────────────────────

export const buyers = pgTable("buyers", {
  id: text("id").primaryKey(),
  /** Better Auth user id (Phase 5). */
  userId: text("user_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  /** Sub-cent remainder of past captures still owed; added to the next capture (PayPal moves whole cents). */
  carryMicros: micros("carry_micros").notNull().default(0),
  /** Where approval requests are emailed (worker, Gmail SMTP). Null means email is off. */
  approvalEmail: text("approval_email"),
  createdAt: createdAt(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agents_buyer_idx").on(t.buyerId)],
);

/** One public key per agent or device; sub-budget keys point at their parent. */
export const agentKeys = pgTable(
  "agent_keys",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    parentKeyId: text("parent_key_id").references((): AnyPgColumn => agentKeys.id),
    publicJwk: jsonb("public_jwk")
      .$type<{ kty: "EC"; crv: "P-256"; x: string; y: string }>()
      .notNull(),
    status: keyStatus("status").notNull().default("active"),
    dailyBudgetMicros: micros("daily_budget_micros"),
    /** Total cap for sub-budget keys. */
    budgetCapMicros: micros("budget_cap_micros"),
    /** Allowed sellers / categories for sub-budget keys. */
    scope: jsonb("scope").$type<{ sellers?: string[]; categories?: string[] }>(),
    expiresAt: tsz("expires_at"),
    revokedAt: tsz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_keys_buyer_idx").on(t.buyerId),
    index("agent_keys_parent_idx").on(t.parentKeyId),
  ],
);

/** Spending policy per buyer (defaults; user-editable). */
export const policies = pgTable("policies", {
  buyerId: text("buyer_id")
    .primaryKey()
    .references(() => buyers.id),
  dailyBudgetMicros: micros("daily_budget_micros").notNull().default(10_000_000),
  perCallMaxMicros: micros("per_call_max_micros").notNull().default(1_000_000),
  approvalThresholdMicros: micros("approval_threshold_micros").notNull().default(2_000_000),
  allowlist: jsonb("allowlist").$type<string[]>(),
  blocklist: jsonb("blocklist").$type<string[]>().notNull().default([]),
  categories: jsonb("categories").$type<string[]>(),
  /** Bumped on every change; part of the guard cache key so edits clear the cache. */
  version: integer("version").notNull().default(1),
  updatedAt: now("updated_at"),
});

// ── Funding ───────────────────────────────────────────────────────────────────

export const mandates = pgTable(
  "mandates",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    provider: text("provider").notNull().default("paypal"),
    rail: rail("rail").notNull(),
    mode: mandateMode("mode").notNull().default("prepaid"),
    status: mandateStatus("status").notNull().default("pending"),
    /** Encrypted vault token (merchant_secrets.kind = vault_token). Never leaves the server. */
    vaultSecretId: text("vault_secret_id"),
    /** PayPal setup token while the buyer is approving (status pending). */
    setupToken: text("setup_token"),
    payerEmail: text("payer_email"),
    creditLimitMicros: micros("credit_limit_micros").notNull().default(10_000_000),
    successfulCaptures: integer("successful_captures").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("mandates_buyer_idx").on(t.buyerId)],
);

export const balances = pgTable(
  "balances",
  {
    buyerId: text("buyer_id")
      .primaryKey()
      .references(() => buyers.id),
    balanceMicros: micros("balance_micros").notNull().default(0),
    floorMicros: micros("floor_micros").notNull().default(2_000_000),
    topUpMicros: micros("top_up_micros").notNull().default(10_000_000),
    autoTopUp: boolean("auto_top_up").notNull().default(true),
    updatedAt: now("updated_at"),
  },
  (t) => [check("balances_non_negative", sql`${t.balanceMicros} >= 0`)],
);

export const topUps = pgTable("top_ups", {
  id: text("id").primaryKey(),
  buyerId: text("buyer_id")
    .notNull()
    .references(() => buyers.id),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  amountMicros: micros("amount_micros").notNull(),
  feeMicros: micros("fee_micros").notNull().default(0),
  status: captureStatus("status").notNull().default("pending"),
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

// ── Sellers ───────────────────────────────────────────────────────────────────

export const sellers = pgTable("sellers", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  name: text("name").notNull(),
  status: sellerStatus("status").notNull().default("active"),
  /** PayPal email or payer id for Payouts. */
  payoutReceiver: text("payout_receiver"),
  /** Sub-cent remainder from past payouts, added to the next one. */
  payoutCarryMicros: micros("payout_carry_micros").notNull().default(0),
  webhookUrl: text("webhook_url"),
  createdAt: createdAt(),
});

/** Envelope-encrypted secrets. `blob` holds ciphertext + wrapped data key. */
export const merchantSecrets = pgTable(
  "merchant_secrets",
  {
    id: text("id").primaryKey(),
    /** Seller or buyer that owns this secret. */
    ownerId: text("owner_id").notNull(),
    kind: secretKind("kind").notNull(),
    blob: text("blob").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("merchant_secrets_owner_kind_idx").on(t.ownerId, t.kind)],
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    method: text("method").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    category: text("category"),
    pricingMode: pricingMode("pricing_mode").notNull(),
    /** Fixed price, or the maximum authorization for metered. */
    priceMicros: micros("price_micros").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("endpoints_seller_method_url_idx").on(t.sellerId, t.method, t.url)],
);

// ── Request path ──────────────────────────────────────────────────────────────

/** Every 402 issued — powers 402 → paid conversion. */
export const quotes = pgTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    amountMicros: micros("amount_micros").notNull(),
    pricingMode: pricingMode("pricing_mode").notNull(),
    status: quoteStatus("status").notNull().default("issued"),
    /** Known once paid (or denied by a guard that reports back). */
    agentKeyId: text("agent_key_id").references(() => agentKeys.id),
    expiresAt: tsz("expires_at").notNull(),
    resolvedAt: tsz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("quotes_seller_created_idx").on(t.sellerId, t.createdAt)],
);

export const guardDecisions = pgTable(
  "guard_decisions",
  {
    id: text("id").primaryKey(),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    quoteId: text("quote_id").references(() => quotes.id),
    sellerId: text("seller_id").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    amountMicros: micros("amount_micros").notNull(),
    intent: text("intent"),
    outcome: guardOutcome("outcome").notNull(),
    decidedBy: guardDecider("decided_by").notNull(),
    /** Rule id that fired, e.g. "deny.per_call_max". */
    rule: text("rule"),
    reason: text("reason"),
    aiDecisionId: text("ai_decision_id"),
    approvalId: text("approval_id"),
    createdAt: createdAt(),
  },
  (t) => [index("guard_decisions_key_created_idx").on(t.agentKeyId, t.createdAt)],
);

/**
 * Cached guard decisions: key = (agent key, seller, endpoint, power-of-two price band,
 * policy version) for 24 h. A policy edit bumps the version, so old entries stop matching.
 */
export const guardCache = pgTable(
  "guard_cache",
  {
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    sellerId: text("seller_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    priceBand: integer("price_band").notNull(),
    policyVersion: integer("policy_version").notNull(),
    outcome: guardOutcome("outcome").notNull(),
    decisionId: text("decision_id").notNull(),
    expiresAt: tsz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("guard_cache_key_idx").on(
      t.agentKeyId,
      t.sellerId,
      t.endpointId,
      t.priceBand,
      t.policyVersion,
    ),
  ],
);

/** Human approval for one purchase above the approval threshold (or when the model says "ask"). */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    sellerId: text("seller_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    /** Maximum this approval covers. */
    amountMicros: micros("amount_micros").notNull(),
    intent: text("intent"),
    reason: text("reason").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedAt: tsz("decided_at"),
    /** Approvals are short-lived: pending ones expire, approved ones must be used soon. */
    expiresAt: tsz("expires_at").notNull(),
    usedChargeId: text("used_charge_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_buyer_status_idx").on(t.buyerId, t.status),
    index("approvals_key_endpoint_idx").on(t.agentKeyId, t.endpointId),
  ],
);

/** One agent key paying one seller. Latest seq and totals. */
export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    lastSeq: integer("last_seq").notNull().default(0),
    cumulativeAuthorizedMicros: micros("cumulative_authorized_micros").notNull().default(0),
    cumulativeRecordedMicros: micros("cumulative_recorded_micros").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: now("updated_at"),
  },
  (t) => [
    uniqueIndex("channels_key_seller_idx").on(t.agentKeyId, t.sellerId),
    check(
      "channels_recorded_le_authorized",
      sql`${t.cumulativeRecordedMicros} <= ${t.cumulativeAuthorizedMicros}`,
    ),
  ],
);

export const vouchers = pgTable(
  "vouchers",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    seq: integer("seq").notNull(),
    cumulativeMicros: micros("cumulative_micros").notNull(),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    expiresAt: tsz("expires_at").notNull(),
    signature: text("signature").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("vouchers_channel_seq_idx").on(t.channelId, t.seq),
    uniqueIndex("vouchers_quote_idx").on(t.quoteId),
  ],
);

/** One row per paid call. */
export const charges = pgTable(
  "charges",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    agentKeyId: text("agent_key_id")
      .notNull()
      .references(() => agentKeys.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    voucherId: text("voucher_id")
      .notNull()
      .references(() => vouchers.id),
    /** Recorded actual (≤ authorized). */
    amountMicros: micros("amount_micros").notNull(),
    authorizedMicros: micros("authorized_micros").notNull(),
    state: chargeState("state").notNull().default("earned"),
    /** Paid from the prepaid balance rather than a post-paid tab. */
    prepaid: boolean("prepaid").notNull().default(false),
    /** Flagged by the buyer (bad output); held out of capture until resolved. */
    held: boolean("held").notNull().default(false),
    intent: text("intent"),
    stateChangedAt: now("state_changed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("charges_quote_idx").on(t.quoteId),
    index("charges_buyer_state_idx").on(t.buyerId, t.state),
    // Spend guard aggregates: today / last hour per buyer and per key, usual price per endpoint.
    index("charges_buyer_created_idx").on(t.buyerId, t.createdAt),
    index("charges_key_created_idx").on(t.agentKeyId, t.createdAt),
    index("charges_buyer_endpoint_created_idx").on(t.buyerId, t.endpointId, t.createdAt),
    index("charges_buyer_seller_idx").on(t.buyerId, t.sellerId),
    index("charges_seller_state_idx").on(t.sellerId, t.state),
    check("charges_amount_le_authorized", sql`${t.amountMicros} <= ${t.authorizedMicros}`),
  ],
);

// ── Settlement ────────────────────────────────────────────────────────────────

/** One buyer capture across every seller on the tab. */
export const settlements = pgTable(
  "settlements",
  {
    id: text("id").primaryKey(),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    rail: rail("rail").notNull(),
    kind: settlementKind("kind").notNull().default("capture"),
    /** Sum of the charges covered. */
    grossMicros: micros("gross_micros").notNull(),
    /** Buyer carry added to this capture, and the sub-cent remainder carried out of it. */
    carryInMicros: micros("carry_in_micros").notNull().default(0),
    carryOutMicros: micros("carry_out_micros").notNull().default(0),
    /** Whole-cent amount charged at the provider: gross + carry in − carry out. 0 for prepaid. */
    capturedMicros: micros("captured_micros").notNull().default(0),
    processorFeeMicros: micros("processor_fee_micros").notNull().default(0),
    status: captureStatus("status").notNull().default("pending"),
    paypalOrderId: text("paypal_order_id"),
    paypalCaptureId: text("paypal_capture_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    capturedAt: tsz("captured_at"),
    createdAt: createdAt(),
  },
  (t) => [index("settlements_buyer_idx").on(t.buyerId)],
);

export const settlementItems = pgTable(
  "settlement_items",
  {
    id: text("id").primaryKey(),
    settlementId: text("settlement_id")
      .notNull()
      .references(() => settlements.id),
    chargeId: text("charge_id")
      .notNull()
      .references(() => charges.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    grossMicros: micros("gross_micros").notNull(),
    processorFeeMicros: micros("processor_fee_micros").notNull(),
    platformFeeMicros: micros("platform_fee_micros").notNull(),
    netMicros: micros("net_micros").notNull(),
    reconState: reconState("recon_state").notNull().default("pending"),
    payoutItemId: text("payout_item_id"),
  },
  (t) => [
    uniqueIndex("settlement_items_charge_idx").on(t.chargeId),
    index("settlement_items_seller_idx").on(t.sellerId),
  ],
);

export const payouts = pgTable("payouts", {
  id: text("id").primaryKey(),
  /** Derived from the run kind and date so retries are idempotent (unique for 30 days at PayPal). */
  senderBatchId: text("sender_batch_id").notNull().unique(),
  paypalPayoutBatchId: text("paypal_payout_batch_id"),
  status: payoutStatus("status").notNull().default("pending"),
  totalMicros: micros("total_micros").notNull(),
  createdAt: createdAt(),
});

export const payoutItems = pgTable(
  "payout_items",
  {
    id: text("id").primaryKey(),
    payoutId: text("payout_id")
      .notNull()
      .references(() => payouts.id),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    /** Whole-cent amount sent. */
    amountMicros: micros("amount_micros").notNull(),
    /** Seller carry consumed by this item, and the remainder it leaves (restored if the item fails). */
    carryInMicros: micros("carry_in_micros").notNull().default(0),
    carryOutMicros: micros("carry_out_micros").notNull().default(0),
    feeMicros: micros("fee_micros").notNull().default(0),
    paypalItemId: text("paypal_item_id"),
    status: payoutStatus("status").notNull().default("pending"),
    reconState: reconState("recon_state").notNull().default("pending"),
  },
  (t) => [index("payout_items_seller_idx").on(t.sellerId)],
);

/** Amounts owed back by a seller (refund after capture), netted from their next payout. */
export const sellerAdjustments = pgTable(
  "seller_adjustments",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    chargeId: text("charge_id").references(() => charges.id),
    /** Positive = the seller owes this much. */
    amountMicros: micros("amount_micros").notNull(),
    reason: text("reason").notNull(),
    /** Set when a payout nets this adjustment. */
    payoutItemId: text("payout_item_id"),
    createdAt: createdAt(),
  },
  (t) => [index("seller_adjustments_seller_idx").on(t.sellerId)],
);

// ── Events and AI ─────────────────────────────────────────────────────────────

/** Inbound provider webhooks, deduplicated by the provider's event id. */
export const webhookEventsIn = pgTable("webhook_events_in", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: now("received_at"),
  processedAt: tsz("processed_at"),
});

/** Outbound merchant events. */
export const eventsOut = pgTable(
  "events_out",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    deliveryStatus: deliveryStatus("delivery_status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tsz("next_attempt_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("events_out_seller_created_idx").on(t.sellerId, t.createdAt)],
);

/** Every model decision. */
export const aiDecisions = pgTable(
  "ai_decisions",
  {
    id: text("id").primaryKey(),
    createdAt: createdAt(),
    agentKind: text("agent_kind").notNull(),
    subjectIds: jsonb("subject_ids").$type<Record<string, string>>().notNull(),
    inputDigest: text("input_digest").notNull(),
    inputRedacted: jsonb("input_redacted"),
    decision: text("decision").notNull(),
    reasoning: text("reasoning"),
    model: text("model").notNull(),
    modelVersion: text("model_version"),
    latencyMs: integer("latency_ms").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsdMicros: micros("cost_usd_micros"),
    humanOverride: text("human_override"),
  },
  (t) => [index("ai_decisions_kind_created_idx").on(t.agentKind, t.createdAt)],
);

// ── Notifications (push approvals and seller alerts) ─────────────────────

/** A browser's Web Push subscription (one per device/browser profile). */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSuccessAt: tsz("last_success_at"),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * Notification outbox: written in the same transaction as the event it reports, delivered by the
 * worker (LISTEN tab402_notify, plus a sweep). `url` is a same-origin path on the web app.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url").notNull(),
    /** Same tag replaces an earlier notification on the device (e.g. one per approval). */
    tag: text("tag"),
    urgency: text("urgency").notNull().default("normal"),
    ttlSeconds: integer("ttl_seconds").notNull().default(86_400),
    createdAt: createdAt(),
    sentAt: tsz("sent_at"),
    /** Devices that accepted it; 0 with sent_at set means the user had no subscribed device. */
    devices: integer("devices"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Email copy (approval requests only): when it was handled, and why it wasn't sent if so. */
    emailSentAt: tsz("email_sent_at"),
    emailError: text("email_error"),
  },
  (t) => [index("notifications_pending_idx").on(t.createdAt).where(sql`${t.sentAt} is null`)],
);

/** Better Auth tables (generated by `pnpm --filter @tab402/auth generate-schema`). */
export * from "./auth-schema";
