import {
  AGENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  HEADERS,
  isTabRequirements,
  newId,
  signAgentRequest,
  signVoucher,
} from "@tab402/core";
import { schema as s } from "@tab402/db";
import { PaymentError, registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS } from "./harness";

const h = await createHarness();
afterAll(h.close);

const body = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Guard me. Please." }),
};

async function newAgent() {
  const a = await registerAgentKey({
    apiUrl: API,
    buyerApiKey: h.buyerKey,
    agentName: `guard-${newId("agent")}`,
    fetch: h.router,
  });
  return {
    ...a,
    client: new Tab402Client({ keyId: a.keyId, privateKey: a.privateKey, fetch: h.router }),
  };
}

async function buyerApi(method: string, path: string, json?: unknown) {
  const res = await h.router(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${h.buyerKey}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const decisions = () => h.db.select().from(s.guardDecisions);

beforeEach(() => h.reset());

describe("spend guard, end to end", () => {
  it("first purchase from a seller goes through the model once, then routine purchases pass on rules", async () => {
    const { client } = await newAgent();
    const res = await client.fetch(`${SELLERS}/v1/summarize`, body, {
      intent: "summarize a customer email",
    });
    expect(res.status).toBe(200);
    expect(await h.db.select().from(s.aiDecisions)).toHaveLength(1);

    for (let i = 0; i < 5; i++)
      expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
    expect(await h.db.select().from(s.aiDecisions)).toHaveLength(1); // no more model calls
    const settled = (await decisions()).filter(
      (d) => d.quoteId && d.outcome === "approve" && d.decidedBy !== "model",
    );
    expect(settled.map((d) => d.decidedBy)).toEqual([
      "cache",
      "rule",
      "rule",
      "rule",
      "rule",
      "rule",
    ]);
    const [first] = (await decisions()).filter((d) => d.decidedBy === "model");
    expect(first).toMatchObject({
      intent: "summarize a customer email",
      rule: "grey.first_time_seller",
    });
  });

  it("the model can deny; nothing is signed into the ledger", async () => {
    const { client } = await newAgent();
    await expect(
      client.fetch(`${SELLERS}/v1/summarize`, body, { intent: "[deny] loop forever" }),
    ).rejects.toMatchObject({ reason: "guard_denied" });
    expect(await h.db.select().from(s.charges)).toHaveLength(0);
  });

  it("hard limits from the buyer's policy are enforced server-side and logged for analytics", async () => {
    expect((await buyerApi("PUT", "/policy", { perCallMax: "5000" })).json).toEqual({ version: 2 });
    const { client } = await newAgent();
    await expect(client.fetch(`${SELLERS}/v1/summarize`, body)).rejects.toMatchObject({
      reason: "guard_denied",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await decisions()).map((d) => d.rule)).toContain("deny.per_call_max");
  });

  it("max_price is checked locally before anything is signed", async () => {
    const { client } = await newAgent();
    await expect(
      client.fetch(`${SELLERS}/v1/chat`, body, { maxPriceMicros: 10_000 }),
    ).rejects.toMatchObject({ reason: "over_max_price" });
    expect(await h.db.select().from(s.vouchers)).toHaveLength(0);
  });

  it("above the approval threshold: ask → buyer approves → retry pays once", async () => {
    await buyerApi("PUT", "/policy", { approvalThreshold: "5000" });
    const { client } = await newAgent();
    let approvalId = "";
    try {
      await client.fetch(`${SELLERS}/v1/summarize`, body, { intent: "summarize the board deck" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      const e = err as PaymentError;
      expect(e.reason).toBe("approval_required");
      expect(e.approval?.url).toBe(`http://web.test/approve/${e.approval?.id}`);
      approvalId = e.approval?.id ?? "";
    }
    const pending = await buyerApi("GET", "/approvals");
    expect((pending.json.data as { id: string; intent: string }[])[0]).toMatchObject({
      id: approvalId,
      intent: "summarize the board deck",
    });
    expect(
      await buyerApi("POST", `/approvals/${approvalId}/decide`, { approve: true }),
    ).toMatchObject({ status: 200, json: { status: "approved" } });

    expect((await client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
    const [approval] = await h.db.select().from(s.approvals).where(eq(s.approvals.id, approvalId));
    expect(approval?.status).toBe("used");
    // Single use: the next purchase needs a new approval.
    await expect(client.fetch(`${SELLERS}/v1/summarize`, body)).rejects.toMatchObject({
      reason: "approval_required",
    });
  });

  it("a policy edit clears cached decisions", async () => {
    const { client } = await newAgent();
    await client.fetch(`${SELLERS}/v1/summarize`, body);
    await buyerApi("PUT", "/policy", { blocklist: [] }); // any edit bumps the version
    await h.db.delete(s.charges); // forget history so the next purchase is grey again
    await client.fetch(`${SELLERS}/v1/summarize`, body);
    expect(await h.db.select().from(s.aiDecisions)).toHaveLength(2);
  });

  it("sub-budget keys are capped", async () => {
    const parent = await newAgent();
    const child = await newAgent();
    await h.db
      .update(s.agentKeys)
      .set({ parentKeyId: parent.keyId, budgetCapMicros: 20_000 })
      .where(eq(s.agentKeys.id, child.keyId));
    expect((await child.client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
    expect((await child.client.fetch(`${SELLERS}/v1/summarize`, body)).status).toBe(200);
    await expect(child.client.fetch(`${SELLERS}/v1/summarize`, body)).rejects.toMatchObject({
      reason: "guard_denied",
      message: "would exceed this sub-budget",
    });
  });
});

describe("the guard can't be bypassed", () => {
  it("a client that skips the guard is stopped at /verify, and a seller that skips /verify is stopped at /settle", async () => {
    const a = await newAgent();
    const res = await h.router(`${SELLERS}/v1/summarize`, body);
    const required = decodePaymentRequiredHeader(res.headers.get(HEADERS.paymentRequired) ?? "");
    const req = required.accepts.find(isTabRequirements);
    if (!req) throw new Error("no tab entry");
    const voucher = await signVoucher(
      {
        channelId: "ch_rogue",
        keyId: a.keyId,
        seq: 1,
        cumulative: req.amount,
        quoteId: req.extra.quoteId,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      a.privateKey,
    );
    const payload = { x402Version: 2, accepted: req, payload: { ...voucher } };

    const paid = await h.router(`${SELLERS}/v1/summarize`, {
      ...body,
      headers: {
        "content-type": "application/json",
        [HEADERS.paymentSignature]: encodePaymentSignatureHeader(payload),
      },
    });
    expect(paid.status).toBe(402);
    expect(decodePaymentRequiredHeader(paid.headers.get(HEADERS.paymentRequired) ?? "").error).toBe(
      "approval_required",
    );

    const settle = await h.router(`${API}/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.sellerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req }),
    });
    expect(await settle.json()).toMatchObject({ success: false, errorReason: "approval_required" });
    expect(await h.db.select().from(s.charges)).toHaveLength(0);
  });

  it("/guard/decide needs a valid agent signature (or a buyer key + keyId)", async () => {
    const a = await newAgent();
    const other = await newAgent();
    const quoteRes = await h.router(`${SELLERS}/v1/summarize`, body);
    const req = decodePaymentRequiredHeader(
      quoteRes.headers.get(HEADERS.paymentRequired) ?? "",
    ).accepts.find(isTabRequirements);
    const payload = JSON.stringify({ quoteId: req?.extra.quoteId });
    const post = (headers: Record<string, string>, b = payload) =>
      h.router(`${API}/guard/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: b,
      });
    const t = Math.floor(Date.now() / 1000);

    expect((await post({})).status).toBe(401);
    const forged = (await signAgentRequest(other.privateKey, other.keyId, payload, t)).replace(
      other.keyId,
      a.keyId,
    );
    expect((await post({ [AGENT_SIGNATURE_HEADER]: forged })).status).toBe(401);
    const stale = await signAgentRequest(a.privateKey, a.keyId, payload, t - 600);
    expect((await post({ [AGENT_SIGNATURE_HEADER]: stale })).status).toBe(401);
    expect(
      (
        await post({
          [AGENT_SIGNATURE_HEADER]: await signAgentRequest(a.privateKey, a.keyId, payload, t),
        })
      ).status,
    ).toBe(200);
    const asBuyer = await post(
      { authorization: `Bearer ${h.buyerKey}` },
      JSON.stringify({ quoteId: req?.extra.quoteId, keyId: a.keyId }),
    );
    expect(asBuyer.status).toBe(200);
    // Agents can't change their own policy: /policy only accepts buyer API keys.
    const sneaky = await h.router(`${API}/policy`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [AGENT_SIGNATURE_HEADER]: await signAgentRequest(a.privateKey, a.keyId, "{}", t),
      },
      body: "{}",
    });
    expect(sneaky.status).toBe(401);
  });
});
