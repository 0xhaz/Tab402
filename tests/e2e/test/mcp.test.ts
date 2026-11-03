import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { confirmPricing, MockOnboardingModel, proposePricing } from "@tab402/agents";
import { schema as s } from "@tab402/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, MCP, SELLERS, SELLERS2 } from "./harness";

const h = await createHarness();
afterAll(h.close);

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(
  opts: {
    agent?: string;
    elicitation?: boolean;
    onElicit?: (params: { url?: string; message: string }) => Promise<"accept" | "decline">;
  } = {},
) {
  // Elicitation-capable clients speak the 2026-07-28 protocol; others stay on the 2025 default.
  const client = new Client(
    { name: "e2e-agent", version: "1.0.0" },
    opts.elicitation
      ? { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: "auto" } }
      : {},
  );
  if (opts.onElicit) {
    const onElicit = opts.onElicit;
    client.setRequestHandler("elicitation/create", async (req) => {
      const params = req.params as { url?: string; message: string };
      return { action: await onElicit(params) };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), {
    fetch: h.router,
    requestInit: {
      headers: {
        authorization: `Bearer ${h.buyerKey}`,
        ...(opts.agent ? { "x-tab402-agent": opts.agent } : {}),
      },
    },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call };
}

const out = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const parsed = <T>(r: ToolResult) => JSON.parse(out(r)) as T;
const summarize = {
  url: `${SELLERS}/v1/summarize`,
  body: { text: "Tab402 lets agents pay per call. Tabs settle in batches." },
  intent: "summarize a note for the user",
};

async function buyerApi(method: string, path: string, json?: unknown) {
  const res = await h.router(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${h.buyerKey}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => h.reset({ mode: "prepaid", balanceMicros: 10_000_000 }));

describe("buyer MCP server", () => {
  it("rejects calls without a buyer key", async () => {
    const res = await h.router(`${MCP}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("lists the buyer tools — and none that change limits", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "call_paid",
      "create_sub_budget",
      "get_budget",
      "get_tab",
      "list_receipts",
      "request_approval",
      "search_services",
    ]);
  });

  it("Phase 7 exit: seller pastes its OpenAPI → priced → in the directory → agent finds and pays it", async () => {
    // Second Seller starts with nothing priced.
    await h.db.delete(s.endpoints).where(eq(s.endpoints.sellerId, "sel_e2e2"));
    const { call } = await connect({ agent: "Claude Code" });
    const before = parsed<{ url: string }[]>(await call("search_services", { query: "summarize" }));
    expect(before.map((f) => f.url)).not.toContain(`${SELLERS2}/v1/summarize`);

    // The onboarding agent reads the seller's own spec. The seller confirms summarize as fixed at
    // $0.01 — the price in their gate's routes config, which re-registers on startup and wins.
    const specText = await (await h.router(`${SELLERS2}/openapi.json`)).text();
    const o = await proposePricing(
      { db: h.db, model: new MockOnboardingModel() },
      { sellerId: "sel_e2e2", specText },
    );
    expect(o.proposals.find((p) => p.key === "GET /health")?.charge).toBe(false);
    const summarizeRoute = o.proposals.find((p) => p.key === "POST /v1/summarize");
    if (!summarizeRoute) throw new Error("no summarize proposal");
    await confirmPricing(h.db, {
      sellerId: "sel_e2e2",
      aiDecisionId: o.aiDecisionId,
      baseUrl: o.api.baseUrl ?? "",
      routes: [{ ...summarizeRoute, pricing: "fixed", priceMicros: 10_000 }],
    });

    const after = parsed<{ url: string; price: string; seller: string }[]>(
      await call("search_services", { query: "summarize" }),
    );
    expect(after.find((f) => f.url === `${SELLERS2}/v1/summarize`)).toMatchObject({
      price: "$0.01",
      seller: "Second Seller",
    });
    const paid = parsed<{ status: number; paid: { amount: string } }>(
      await call("call_paid", { ...summarize, url: `${SELLERS2}/v1/summarize` }),
    );
    expect(paid).toMatchObject({ status: 200, paid: { amount: "$0.01" } });
  });

  it("search → call_paid → receipts: the demo flow", async () => {
    const { call } = await connect({ agent: "Claude Code" });
    const found = parsed<{ url: string; price: string }[]>(
      await call("search_services", { query: "summarize text" }),
    );
    expect(found.map((f) => f.url)).toContain(`${SELLERS}/v1/summarize`);
    expect(found.find((f) => f.url.endsWith("/summarize"))?.price).toBe("$0.01");

    const paid = parsed<{ status: number; paid: { amount: string }; body: string }>(
      await call("call_paid", summarize),
    );
    expect(paid).toMatchObject({ status: 200, paid: { amount: "$0.01" } });
    expect(paid.body).toContain("[mock]");
    expect((await call("call_paid", summarize)).isError).toBeFalsy(); // routine now

    const receipts = parsed<{ amount: string; intent: string | null; seller: string }[]>(
      await call("list_receipts", { period: "today" }),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ amount: "$0.01", seller: "Demo Sellers" });
    expect(receipts.every((r) => r.intent === "summarize a note for the user")).toBe(true);

    const budget = parsed<{
      buyer: { spent_today: string };
      funding: { mode: string; balance: string };
    }>(await call("get_budget"));
    expect(budget).toMatchObject({
      buyer: { spent_today: "$0.02" },
      funding: { mode: "prepaid", balance: "$9.98" },
    });
  });

  it("only pays registered Tab402 endpoints (no SSRF)", async () => {
    const { call } = await connect();
    const r = await call("call_paid", {
      url: "http://169.254.169.254/latest/meta-data",
      method: "GET",
      intent: "steal credentials",
    });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("not a Tab402 endpoint");
  });

  it("each agent gets its own key and receipts", async () => {
    const a = await connect({ agent: "coder" });
    const b = await connect({ agent: "researcher" });
    await a.call("call_paid", summarize);
    expect(parsed<unknown[]>(await b.call("list_receipts"))).toHaveLength(0);
    const agents = await h.db.select().from(s.agents);
    expect(agents.map((x) => x.name).sort()).toEqual(["coder", "researcher"]);
  });

  it("a revoked agent stays revoked (no fresh key); 'Allow again' re-admits it with a new key", async () => {
    const { call } = await connect({ agent: "Claude Code" });
    expect((await call("call_paid", summarize)).isError).toBeFalsy();
    const [first] = await h.db.select().from(s.agentKeys);
    // Dashboard → Revoke.
    await h.db
      .update(s.agentKeys)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(s.agentKeys.id, first?.id ?? ""));
    h.keys.invalidate(first?.id ?? "");
    const refused = await call("call_paid", summarize);
    expect(refused.isError).toBe(true);
    expect(out(refused)).toContain('access for agent "Claude Code" was revoked');
    expect(await h.db.select().from(s.agentKeys)).toHaveLength(1); // no replacement key minted

    // Dashboard → Allow again: the revoked key's private key is destroyed, so a new one is issued.
    await h.db
      .delete(s.merchantSecrets)
      .where(
        and(
          eq(s.merchantSecrets.ownerId, first?.id ?? ""),
          eq(s.merchantSecrets.kind, "agent_private_key"),
        ),
      );
    expect((await call("call_paid", summarize)).isError).toBeFalsy();
    const keys = await h.db.select().from(s.agentKeys);
    expect(keys.map((k) => k.status).sort()).toEqual(["active", "revoked"]);
  });

  it("a frozen agent key is kept frozen, not swapped for a fresh one", async () => {
    const { call } = await connect({ agent: "Claude Code" });
    expect((await call("call_paid", summarize)).isError).toBeFalsy();
    await h.db.update(s.agentKeys).set({ status: "frozen" });
    h.keys.invalidate((await h.db.select().from(s.agentKeys))[0]?.id ?? "");
    expect((await call("call_paid", summarize)).isError).toBe(true);
    expect(await h.db.select().from(s.agentKeys)).toHaveLength(1);
  });

  it("over the threshold: URL elicitation → buyer approves on the page → the call completes", async () => {
    await buyerApi("PUT", "/policy", { approvalThreshold: "5000" });
    const seen: string[] = [];
    const { call } = await connect({
      elicitation: true,
      onElicit: async ({ url }) => {
        seen.push(url ?? "");
        const id = (url ?? "").split("/").pop() ?? "";
        await buyerApi("POST", `/approvals/${id}/decide`, { approve: true }); // the human, on the approval page
        return "accept";
      },
    });
    const r = await call("call_paid", summarize);
    expect(r.isError).toBeFalsy();
    expect(parsed<{ status: number }>(r).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^http:\/\/web\.test\/approve\/apr_/);
    const [approval] = await h.db.select().from(s.approvals);
    expect(approval?.status).toBe("used");
  });

  it("buyer declines → the tool reports it", async () => {
    await buyerApi("PUT", "/policy", { approvalThreshold: "5000" });
    const { call } = await connect({
      elicitation: true,
      onElicit: async ({ url }) => {
        await buyerApi("POST", `/approvals/${(url ?? "").split("/").pop()}/decide`, {
          approve: false,
        });
        return "accept";
      },
    });
    const r = await call("call_paid", summarize);
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("declined");
    expect(await h.db.select().from(s.charges)).toHaveLength(0);
  });

  it("clients without URL elicitation get the link; the agent retries after approval", async () => {
    await buyerApi("PUT", "/policy", { approvalThreshold: "5000" });
    const { call } = await connect();
    const first = await call("call_paid", summarize);
    expect(out(first)).toMatch(/Approve here: http:\/\/web\.test\/approve\/apr_\w+/);
    const id = /approve\/(apr_\w+)/.exec(out(first))?.[1];
    await buyerApi("POST", `/approvals/${id}/decide`, { approve: true });
    expect(parsed<{ status: number }>(await call("call_paid", summarize)).status).toBe(200);
  });

  it("sub-budgets: capped, scoped to this agent, visible in get_budget", async () => {
    const { call } = await connect({ agent: "lead" });
    const sub = parsed<{ sub_budget: string; cap: string }>(
      await call("create_sub_budget", { amount: "0.02", expires_in_minutes: 30 }),
    );
    expect(sub.cap).toBe("$0.02");
    for (let i = 0; i < 2; i++)
      expect(
        (await call("call_paid", { ...summarize, sub_budget: sub.sub_budget })).isError,
      ).toBeFalsy();
    const third = await call("call_paid", { ...summarize, sub_budget: sub.sub_budget });
    expect(third.isError).toBe(true);
    expect(out(third)).toContain("spend guard denied it: would exceed this sub-budget");
    const budget = parsed<{ sub_budgets: { id: string; spent: string }[] }>(
      await call("get_budget"),
    );
    expect(budget.sub_budgets).toEqual([
      expect.objectContaining({ id: sub.sub_budget, spent: "$0.02" }),
    ]);
    expect((await call("create_sub_budget", { amount: "50" })).isError).toBe(true); // more than today's budget

    const other = await connect({ agent: "someone-else" });
    expect(
      (await other.call("call_paid", { ...summarize, sub_budget: sub.sub_budget })).isError,
    ).toBe(true);
  });

  it("request_approval up front, then call_paid uses it", async () => {
    await buyerApi("PUT", "/policy", { approvalThreshold: "5000" });
    const { call } = await connect({
      elicitation: true,
      onElicit: async ({ url }) => {
        await buyerApi("POST", `/approvals/${(url ?? "").split("/").pop()}/decide`, {
          approve: true,
        });
        return "accept";
      },
    });
    expect(
      out(
        await call("request_approval", {
          url: `${SELLERS}/v1/summarize`,
          amount: "0.01",
          reason: "summarize the board deck",
        }),
      ),
    ).toContain("Approved");
    expect(parsed<{ status: number }>(await call("call_paid", summarize)).status).toBe(200);
  });

  it("get_tab shows unsettled charges by seller (post-paid)", async () => {
    await h.reset({ mode: "postpaid", creditLimitMicros: 100_000_000 });
    const { call } = await connect();
    await call("call_paid", summarize);
    await call("call_paid", summarize);
    expect(parsed<unknown>(await call("get_tab"))).toEqual({
      open_total: "$0.02",
      by_seller: [{ seller: "Demo Sellers", calls: 2, amount: "$0.02" }],
    });
    const keys = await h.db
      .select()
      .from(s.merchantSecrets)
      .where(eq(s.merchantSecrets.kind, "agent_private_key"));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.blob).not.toContain('"d"'); // private key is sealed, not stored in clear
  });
});
