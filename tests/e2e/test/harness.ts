import { randomBytes } from "node:crypto";
import { createApp as createApi } from "@tab402/api/app";
import { AgentKeyCache } from "@tab402/api/key-cache";
import { newId, TAB_NETWORKS } from "@tab402/core";
import { createDb, generateApiKey, schema as s, sealSecret } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { createApp as createSellers, DEMO_ROUTES } from "@tab402/demo-sellers/app";
import { MockLlm } from "@tab402/demo-sellers/llm";
import { type GuardModel, MockGuardModel } from "@tab402/guard";
import { DEFAULT_LEDGER_CONFIG, type EnqueueOptions, type JobName } from "@tab402/ledger";
import { createMcpApp } from "@tab402/mcp-buyer/app";
import type { PushOptions, PushPayload, PushSender, PushTarget, SendResult } from "@tab402/notify";
import type { CaptureResult, FundingAdapter, PayoutAdapter, PayoutItemInput } from "@tab402/paypal";
import { PayPalClient } from "@tab402/paypal";
import { createJobs } from "@tab402/worker/jobs";
import { sql } from "drizzle-orm";

export const API = "http://api.test";
export const SELLERS = "http://sellers.test";
export const SELLERS2 = "http://sellers2.test";
export const MERCHANT_HOOK = "http://merchant.test/hooks/tab402";
export const MCP = "http://mcp.test";

/** PayPal US standard rate, as observed in sandbox: 3.49% + $0.49. */
export function paypalFee(micros: number): number {
  const cents = Math.round((micros * 0.0349 + 490_000) / 10_000);
  return cents * 10_000;
}

/** In-memory PayPal: records every call, captures succeed unless told to decline. */
export class FakePayPal implements FundingAdapter, PayoutAdapter {
  captures: Parameters<FundingAdapter["capture"]>[0][] = [];
  payouts: { senderBatchId: string; items: PayoutItemInput[] }[] = [];
  declineNext = 0;
  payoutFeeMicros = 250_000;

  async beginMandate() {
    return {
      setupToken: "SETUP-1",
      approveUrl: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP-1",
    };
  }
  async completeMandate() {
    return { vaultToken: "VAULT-FAKE", payerEmail: "buyer@personal.example.com" };
  }
  async capture(input: Parameters<FundingAdapter["capture"]>[0]): Promise<CaptureResult> {
    this.captures.push(input);
    if (this.declineNext > 0) {
      this.declineNext--;
      return {
        status: "declined",
        orderId: `O-${this.captures.length}`,
        reason: "INSTRUMENT_DECLINED",
      };
    }
    return {
      status: "captured",
      orderId: `O-${this.captures.length}`,
      captureId: `C-${this.captures.length}`,
      grossMicros: input.amountMicros,
      feeMicros: paypalFee(input.amountMicros),
    };
  }
  async getOrder() {
    return { status: "COMPLETED", captureStatus: "COMPLETED" };
  }
  async payout(senderBatchId: string, items: PayoutItemInput[]) {
    this.payouts.push({ senderBatchId, items });
    return { batchId: `B-${this.payouts.length}` };
  }
  async getBatch(batchId: string) {
    const batch = this.payouts[Number(batchId.slice(2)) - 1];
    return {
      batchId,
      status: "success" as const,
      items: (batch?.items ?? []).map((i) => ({
        itemId: i.itemId,
        providerItemId: `PI-${i.itemId}`,
        status: "success" as const,
        feeMicros: this.payoutFeeMicros,
      })),
    };
  }
}

/**
 * Whole system in one process: facilitator API + two demo sellers + client + worker jobs, wired
 * through an in-memory fetch router (no sockets) and a fake PayPal, against tab402_e2e.
 */
/** Web Push stand-in: records what the worker would send to each device. */
export class FakePush implements PushSender {
  sent: { endpoint: string; payload: PushPayload; options: PushOptions }[] = [];
  async send(target: PushTarget, payload: string, options: PushOptions): Promise<SendResult> {
    this.sent.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as PushPayload,
      options,
    });
    return { ok: true };
  }
}

export async function createHarness() {
  const url = process.env.DATABASE_URL_E2E;
  if (!url) throw new Error("DATABASE_URL_E2E is not set");
  await runMigrations(url);
  const { db, close } = createDb(url, { max: 5 });

  const masterKey = randomBytes(32);
  const paypal = new FakePayPal();
  const push = new FakePush();
  const queued: { name: JobName; data: object; options?: EnqueueOptions }[] = [];
  const enqueue = async (name: JobName, data: object, options?: EnqueueOptions) => {
    queued.push({ name, data, options });
  };

  const keys = new AgentKeyCache(db); // Production TTL (30 s); tests call keys.invalidate() to simulate expiry.
  const guard: { model: GuardModel; approvalBaseUrl: string } = {
    model: new MockGuardModel(),
    approvalBaseUrl: "http://web.test/approve",
  };
  const apiDeps: Parameters<typeof createApi>[0] = {
    db,
    keys,
    guard,
    masterKey,
    enqueue,
    paypal: {
      client: new PayPalClient({ clientId: "x", clientSecret: "y", env: "sandbox" }),
      funding: paypal,
      skipWebhookVerification: true,
    },
    config: { network: TAB_NETWORKS.sandbox, facilitatorUrl: API, quoteTtlSeconds: 300 },
  };
  const api = createApi(apiDeps);

  const sellerKey = generateApiKey("seller");
  const seller2Key = generateApiKey("seller");
  const buyerKey = generateApiKey("buyer");

  /** Requests received by the merchant's webhook endpoint. */
  const merchantHooks: { headers: Headers; body: string }[] = [];

  /** Wall time of facilitator calls by path, for the gate-overhead benchmark. */
  const timings = new Map<string, number[]>();
  const router: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const { origin: host, pathname } = new URL(req.url);
    if (host === API) {
      const t0 = performance.now();
      const res = await api.fetch(req);
      const list = timings.get(pathname) ?? [];
      list.push(performance.now() - t0);
      timings.set(pathname, list);
      return res;
    }
    if (host === SELLERS) return sellers.fetch(req);
    if (host === SELLERS2) return sellers2.fetch(req);
    if (host === MCP) {
      // Real HTTP always carries Host; the MCP app's DNS-rebinding guard requires it.
      const headers = new Headers(req.headers);
      headers.set("host", new URL(MCP).host);
      return mcp.fetch(new Request(req, { headers }));
    }
    if (req.url === MERCHANT_HOOK) {
      merchantHooks.push({ headers: req.headers, body: await req.text() });
      return new Response("ok");
    }
    throw new Error(`no route for ${req.url}`);
  };

  const sellers = createSellers({
    gate: { facilitatorUrl: API, apiKey: sellerKey.key, baseUrl: SELLERS, fetch: router },
    llm: new MockLlm(),
  });
  const sellers2 = createSellers({
    gate: { facilitatorUrl: API, apiKey: seller2Key.key, baseUrl: SELLERS2, fetch: router },
    llm: new MockLlm(),
  });

  const mcp = createMcpApp({
    db,
    masterKey,
    fetch: router,
    approvalBaseUrl: "http://web.test/approve",
    allowedHosts: ["mcp.test"],
  });

  let clock: (() => Date) | undefined;
  const worker = createJobs({
    db,
    funding: paypal,
    payouts: paypal,
    masterKey,
    cfg: DEFAULT_LEDGER_CONFIG,
    enqueue,
    fetch: router,
    now: () => clock?.() ?? new Date(),
    log: { info() {}, warn() {}, error() {} },
    push,
  });

  /** Run queued jobs until none are left. Jobs scheduled for later only run when `includeDelayed`. */
  async function drain(includeDelayed = false) {
    for (let guard = 0; guard < 1000; guard++) {
      const i = queued.findIndex((j) => includeDelayed || !j.options?.startAfter);
      if (i === -1) return;
      const [job] = queued.splice(i, 1);
      if (job) await (worker[job.name] as (d: unknown) => Promise<void>)(job.data);
    }
  }

  async function reset(
    opts: {
      mode?: "prepaid" | "postpaid";
      balanceMicros?: number;
      creditLimitMicros?: number;
    } = {},
  ) {
    const tables = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    await db.execute(
      sql.raw(
        `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
      ),
    );
    queued.length = 0;
    merchantHooks.length = 0;
    paypal.captures = [];
    push.sent = [];
    paypal.payouts = [];
    paypal.declineNext = 0;
    clock = undefined;
    apiDeps.guard = guard; // the spend guard is on unless a test turns it off

    // Stable ids: the API caches key → principal for 30 s, so owners must survive a reset.
    const sellerId = "sel_e2e";
    const seller2Id = "sel_e2e2";
    const buyerId = "buy_e2e";
    await db.insert(s.sellers).values([
      { id: sellerId, name: "Demo Sellers", payoutReceiver: "seller1@business.example.com" },
      { id: seller2Id, name: "Second Seller", payoutReceiver: "seller2@business.example.com" },
    ]);
    await db.insert(s.buyers).values({ id: buyerId, name: "Buyer", email: "b@example.com" });
    await db.insert(s.policies).values({ buyerId });
    const mandateId = newId("mandate");
    const secretId = newId("secret");
    await db.insert(s.merchantSecrets).values({
      id: secretId,
      ownerId: mandateId,
      kind: "vault_token",
      blob: sealSecret(masterKey, mandateId, "vault_token", "VAULT-FAKE"),
    });
    await db.insert(s.mandates).values({
      id: mandateId,
      buyerId,
      rail: "paypal_wallet",
      mode: opts.mode ?? "prepaid",
      status: "active",
      vaultSecretId: secretId,
      creditLimitMicros: opts.creditLimitMicros ?? 10_000_000,
    });
    await db
      .insert(s.balances)
      .values({ buyerId, balanceMicros: opts.balanceMicros ?? 10_000_000 });
    // The gates register their routes once per process; re-create them after the truncate.
    for (const [id, base] of [
      [sellerId, SELLERS],
      [seller2Id, SELLERS2],
    ] as const) {
      await db.insert(s.endpoints).values(
        Object.entries(DEMO_ROUTES).map(([route, cfg]) => {
          const [method = "POST", path = "/"] = route.split(" ");
          return {
            id: newId("endpoint"),
            sellerId: id,
            method,
            url: `${base}${path}`,
            pricingMode: cfg.pricing,
            priceMicros: cfg.price,
            description: cfg.description,
            category: cfg.category,
          };
        }),
      );
    }
    await db.insert(s.apiKeys).values([
      {
        id: newId("apiKey"),
        ownerType: "seller",
        ownerId: sellerId,
        prefix: sellerKey.prefix,
        hash: sellerKey.hash,
      },
      {
        id: newId("apiKey"),
        ownerType: "seller",
        ownerId: seller2Id,
        prefix: seller2Key.prefix,
        hash: seller2Key.hash,
      },
      {
        id: newId("apiKey"),
        ownerType: "buyer",
        ownerId: buyerId,
        prefix: buyerKey.prefix,
        hash: buyerKey.hash,
      },
    ]);
    return { sellerId, seller2Id, buyerId, mandateId };
  }

  return {
    db,
    close,
    router,
    reset,
    timings,
    sellerKey: sellerKey.key,
    seller2Key: seller2Key.key,
    buyerKey: buyerKey.key,
    keys,
    paypal,
    push,
    queued,
    worker,
    drain,
    merchantHooks,
    setClock: (fn: (() => Date) | undefined) => {
      clock = fn;
    },
    /** Protocol-level tests (hand-built vouchers) run without the spend guard. */
    setGuard: (on: boolean, model?: GuardModel) => {
      apiDeps.guard = on ? { ...guard, model: model ?? guard.model } : undefined;
    },
  };
}
