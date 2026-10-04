import { createHash } from "node:crypto";
import { formatUsd, newId } from "@tab402/core";
import { type Database, queueNotification, schema as s } from "@tab402/db";
import { and, eq, gt, gte } from "drizzle-orm";
import {
  type GuardSubject,
  type GuardSubjectInfo,
  type LoadedGuardContext,
  loadGuardContext,
} from "./context";
import type { GuardModel, GuardModelInput } from "./model";
import { evaluateRules, priceBand, type RuleResult } from "./rules";

type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface GuardDeps {
  db: Database;
  model: GuardModel;
  now?: () => Date;
  /** Base URL of the approval page, e.g. http://localhost:3000/approve — the approval id is appended. */
  approvalBaseUrl?: string;
  /** Decision cache lifetime (24 h). */
  cacheTtlMs?: number;
  /** How long a human has to approve, and how long an approval stays usable. */
  approvalTtlMs?: number;
}

export interface ApprovalRef {
  id: string;
  url: string | null;
  expiresAt: Date;
  status: "pending" | "approved";
}

export interface GuardDecision {
  outcome: "approve" | "deny" | "ask";
  decidedBy: "rule" | "cache" | "model" | "human";
  rule: string;
  reason: string;
  decisionId: string;
  approval?: ApprovalRef;
}

const DAY = 24 * 3600_000;

/** Every outcome is logged — powers the denial analytics in the dashboard. */
export async function recordGuardDecision(
  db: Executor,
  d: {
    subject: GuardSubject;
    quoteId?: string | null;
    endpointUrl: string;
    intent?: string | null;
    outcome: "approve" | "deny" | "ask";
    decidedBy: "rule" | "cache" | "model" | "human";
    rule: string;
    reason?: string | null;
    aiDecisionId?: string | null;
    approvalId?: string | null;
  },
): Promise<string> {
  const id = newId("guardDecision");
  await db.insert(s.guardDecisions).values({
    id,
    agentKeyId: d.subject.agentKeyId,
    quoteId: d.quoteId ?? null,
    sellerId: d.subject.sellerId,
    endpointUrl: d.endpointUrl,
    amountMicros: d.subject.amountMicros,
    intent: d.intent ?? null,
    outcome: d.outcome,
    decidedBy: d.decidedBy,
    rule: d.rule,
    reason: d.reason ?? null,
    aiDecisionId: d.aiDecisionId ?? null,
    approvalId: d.approvalId ?? null,
  });
  return id;
}

export type VerifyGuardResult =
  | { ok: true; decidedBy: "rule" | "cache" | "human"; rule: string; approvalId?: string }
  | { ok: false; reason: "guard_denied" | "approval_required"; rule: string; message: string };

/**
 * Hot-path enforcement inside the facilitator's /verify — no model calls. Routine purchases pass on
 * rules; grey-zone ones need a cached decision; over-threshold ones need a human approval. Anything
 * else is `approval_required`, and the client asks POST /guard/decide.
 */
export async function checkAtVerify(
  deps: GuardDeps,
  ref: { agentKeyId: string; buyerId: string; quoteId: string },
): Promise<VerifyGuardResult> {
  const now = deps.now?.() ?? new Date();
  const loaded = await loadGuardContext(deps.db, ref, now);
  const r = evaluateRules(loaded.ctx);

  if (r.outcome === "approve") return { ok: true, decidedBy: "rule", rule: r.rule };
  if (r.outcome === "deny") {
    void recordGuardDecision(deps.db, {
      subject: loaded.subject,
      quoteId: ref.quoteId,
      endpointUrl: loaded.info.endpointUrl,
      outcome: "deny",
      decidedBy: "rule",
      rule: r.rule,
      reason: r.message,
    }).catch(() => {});
    return { ok: false, reason: "guard_denied", rule: r.rule, message: r.message };
  }
  if (r.outcome === "grey") {
    if (loaded.cached === "approve") return { ok: true, decidedBy: "cache", rule: r.rule };
    if (loaded.cached === "deny")
      return {
        ok: false,
        reason: "guard_denied",
        rule: r.rule,
        message: "denied by an earlier spend check",
      };
  }
  if (loaded.approvalId)
    return { ok: true, decidedBy: "human", rule: r.rule, approvalId: loaded.approvalId };
  return {
    ok: false,
    reason: "approval_required",
    rule: r.rule,
    message: "this purchase needs a spend check: call POST /guard/decide",
  };
}

function modelInput(
  r: Extract<RuleResult, { outcome: "grey" }>,
  ctx: LoadedGuardContext["ctx"],
  info: GuardSubjectInfo,
  intent: string | null,
): GuardModelInput {
  const usd = (m: number) => (m / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
  return {
    quote: {
      seller: info.sellerName,
      endpoint: info.endpointUrl,
      description: info.description,
      category: info.category,
      pricing: info.pricing,
      priceUsd: usd(ctx.amountMicros),
    },
    intent,
    flags: r.reasons,
    policy: {
      dailyBudgetRemainingUsd: usd(
        Math.max(0, ctx.policy.dailyBudgetMicros - ctx.spend.buyerTodayMicros),
      ),
      perCallMaxUsd: usd(ctx.policy.perCallMaxMicros),
      approvalThresholdUsd: usd(ctx.policy.approvalThresholdMicros),
      categories: ctx.policy.categories,
    },
    history: {
      sellerKnown: ctx.sellerKnown,
      usualPriceUsd: ctx.usualPriceMicros === null ? null : usd(ctx.usualPriceMicros),
      spentLastHourUsd: usd(ctx.spend.lastHourMicros),
    },
  };
}

/** Open (or reuse) a pending human approval for a purchase — also used by the MCP `request_approval` tool. */
export async function openApproval(
  deps: GuardDeps,
  subject: GuardSubject,
  intent: string | null,
  reason: string,
  now: Date,
): Promise<ApprovalRef> {
  // Reuse a pending request for the same purchase instead of stacking duplicates.
  const [pending] = await deps.db
    .select()
    .from(s.approvals)
    .where(
      and(
        eq(s.approvals.agentKeyId, subject.agentKeyId),
        eq(s.approvals.endpointId, subject.endpointId),
        eq(s.approvals.status, "pending"),
        gte(s.approvals.amountMicros, subject.amountMicros),
        gt(s.approvals.expiresAt, now),
      ),
    )
    .limit(1);
  const url = (id: string) =>
    deps.approvalBaseUrl ? `${deps.approvalBaseUrl.replace(/\/+$/, "")}/${id}` : null;
  if (pending)
    return {
      id: pending.id,
      url: url(pending.id),
      expiresAt: pending.expiresAt,
      status: "pending",
    };

  const id = newId("approval");
  const ttlMs = deps.approvalTtlMs ?? 15 * 60_000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const [names] = await deps.db
    .select({ seller: s.sellers.name, agent: s.agents.name })
    .from(s.agentKeys)
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .innerJoin(s.sellers, eq(s.sellers.id, subject.sellerId))
    .where(eq(s.agentKeys.id, subject.agentKeyId));
  await deps.db.transaction(async (tx) => {
    await tx.insert(s.approvals).values({
      id,
      buyerId: subject.buyerId,
      agentKeyId: subject.agentKeyId,
      sellerId: subject.sellerId,
      endpointId: subject.endpointId,
      amountMicros: subject.amountMicros,
      intent,
      reason,
      expiresAt,
    });
    // Push to the buyer's phone — the fallback for MCP clients without URL elicitation.
    await queueNotification(
      tx,
      { buyerId: subject.buyerId },
      {
        kind: "approval.requested",
        title: `Approve ${formatUsd(subject.amountMicros)} for ${names?.seller ?? "a paid API"}?`,
        body: `${names?.agent ?? "Your agent"}${intent ? `: ${intent}` : " is waiting for you"}`,
        url: `/approve/${id}`,
        tag: id,
        urgency: "high",
        ttlSeconds: Math.floor(ttlMs / 1000),
      },
    );
  });
  return { id, url: url(id), expiresAt, status: "pending" };
}

/**
 * Full spend check for one quote (POST /guard/decide): rules, then cache, then the model for the
 * grey zone, then a human for "ask". Every step is logged.
 */
export async function decide(
  deps: GuardDeps,
  ref: { agentKeyId: string; buyerId: string; quoteId: string },
  opts: { intent?: string | null } = {},
): Promise<GuardDecision> {
  const now = deps.now?.() ?? new Date();
  const intent = opts.intent?.slice(0, 500) ?? null;
  const loaded = await loadGuardContext(deps.db, ref, now);
  const { ctx, info, subject } = loaded;
  const r = evaluateRules(ctx);
  const log = (
    outcome: GuardDecision["outcome"],
    decidedBy: GuardDecision["decidedBy"],
    reason: string,
    extra: { aiDecisionId?: string; approvalId?: string } = {},
  ) =>
    recordGuardDecision(deps.db, {
      subject,
      quoteId: ref.quoteId,
      endpointUrl: info.endpointUrl,
      intent,
      outcome,
      decidedBy,
      rule: r.rule,
      reason,
      ...extra,
    });

  if (r.outcome === "deny")
    return {
      outcome: "deny",
      decidedBy: "rule",
      rule: r.rule,
      reason: r.message,
      decisionId: await log("deny", "rule", r.message),
    };
  if (r.outcome === "approve") {
    const reason = "routine: known seller at its usual price";
    return {
      outcome: "approve",
      decidedBy: "rule",
      rule: r.rule,
      reason,
      decisionId: await log("approve", "rule", reason),
    };
  }

  if (loaded.approvalId) {
    const approvalId = loaded.approvalId;
    return {
      outcome: "approve",
      decidedBy: "human",
      rule: r.rule,
      reason: "approved by the buyer",
      decisionId: await log("approve", "human", "approved by the buyer", { approvalId }),
    };
  }

  if (r.outcome === "ask") {
    const approval = await openApproval(deps, subject, intent, r.message, now);
    return {
      outcome: "ask",
      decidedBy: "rule",
      rule: r.rule,
      reason: r.message,
      approval,
      decisionId: await log("ask", "rule", r.message, { approvalId: approval.id }),
    };
  }

  const cached = loaded.cached;
  if (cached === "approve" || cached === "deny") {
    const reason = `same decision as an earlier check (${r.reasons.join(", ")})`;
    return {
      outcome: cached,
      decidedBy: "cache",
      rule: r.rule,
      reason,
      decisionId: await log(cached, "cache", reason),
    };
  }

  const input = modelInput(r, ctx, info, intent);
  const m = await deps.model.decide(input);
  const aiDecisionId = newId("aiDecision");
  const inputJson = JSON.stringify(input);
  await deps.db.insert(s.aiDecisions).values({
    id: aiDecisionId,
    agentKind: "guard",
    subjectIds: {
      agentKeyId: subject.agentKeyId,
      sellerId: subject.sellerId,
      endpointId: subject.endpointId,
      quoteId: ref.quoteId,
    },
    inputDigest: createHash("sha256").update(inputJson).digest("hex"),
    inputRedacted: input,
    decision: m.decision,
    reasoning: m.reasoning,
    model: m.model,
    modelVersion: m.model,
    latencyMs: m.latencyMs,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    costUsdMicros: m.costMicros ?? null,
  });

  if (m.decision === "ask") {
    const approval = await openApproval(deps, subject, intent, m.reasoning, now);
    return {
      outcome: "ask",
      decidedBy: "model",
      rule: r.rule,
      reason: m.reasoning,
      approval,
      decisionId: await log("ask", "model", m.reasoning, { aiDecisionId, approvalId: approval.id }),
    };
  }

  const decisionId = await log(m.decision, "model", m.reasoning, { aiDecisionId });
  const cacheRow = {
    agentKeyId: subject.agentKeyId,
    sellerId: subject.sellerId,
    endpointId: subject.endpointId,
    priceBand: priceBand(subject.amountMicros),
    policyVersion: ctx.policy.version,
    outcome: m.decision,
    decisionId,
    expiresAt: new Date(now.getTime() + (deps.cacheTtlMs ?? DAY)),
  };
  await deps.db
    .insert(s.guardCache)
    .values(cacheRow)
    .onConflictDoUpdate({
      target: [
        s.guardCache.agentKeyId,
        s.guardCache.sellerId,
        s.guardCache.endpointId,
        s.guardCache.priceBand,
        s.guardCache.policyVersion,
      ],
      set: { outcome: cacheRow.outcome, decisionId, expiresAt: cacheRow.expiresAt, createdAt: now },
    });
  return { outcome: m.decision, decidedBy: "model", rule: r.rule, reason: m.reasoning, decisionId };
}

/** The buyer approves or denies a pending request (dashboard / approval page). */
export async function decideApproval(
  deps: Pick<GuardDeps, "db" | "now" | "approvalTtlMs">,
  approvalId: string,
  buyerId: string,
  approve: boolean,
): Promise<"approved" | "denied" | "not_found" | "expired"> {
  const now = deps.now?.() ?? new Date();
  const [a] = await deps.db
    .select()
    .from(s.approvals)
    .where(and(eq(s.approvals.id, approvalId), eq(s.approvals.buyerId, buyerId)));
  if (a?.status !== "pending") return "not_found";
  if (a.expiresAt <= now) {
    await deps.db
      .update(s.approvals)
      .set({ status: "expired" })
      .where(eq(s.approvals.id, approvalId));
    return "expired";
  }
  const status = approve ? "approved" : "denied";
  await deps.db
    .update(s.approvals)
    .set({
      status,
      decidedAt: now,
      expiresAt: approve
        ? new Date(now.getTime() + (deps.approvalTtlMs ?? 15 * 60_000))
        : a.expiresAt,
    })
    .where(and(eq(s.approvals.id, approvalId), eq(s.approvals.status, "pending")));
  await recordGuardDecision(deps.db, {
    subject: {
      agentKeyId: a.agentKeyId,
      buyerId,
      sellerId: a.sellerId,
      endpointId: a.endpointId,
      amountMicros: a.amountMicros,
    },
    endpointUrl: "",
    intent: a.intent,
    outcome: approve ? "approve" : "deny",
    decidedBy: "human",
    rule: "human.approval",
    reason: approve ? `buyer approved up to ${formatUsd(a.amountMicros)}` : "buyer declined",
    approvalId,
  });
  return status;
}

/** Single use: mark an approval consumed by a charge. Returns false if it was already used or expired. */
export async function consumeApproval(
  db: Executor,
  approvalId: string,
  chargeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const used = await db
    .update(s.approvals)
    .set({ status: "used", usedChargeId: chargeId })
    .where(
      and(
        eq(s.approvals.id, approvalId),
        eq(s.approvals.status, "approved"),
        gt(s.approvals.expiresAt, now),
      ),
    )
    .returning({ id: s.approvals.id });
  return used.length > 0;
}
