import { confirmPricing, MockOnboardingModel, proposePricing } from "@tab402/agents";
import { schema as s } from "@tab402/db";
import { registerAgentKey, Tab402Client } from "@tab402/sdk-client";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS } from "./harness";

const h = await createHarness();
afterAll(h.close);

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function onboard() {
  const specText = await (await h.router(`${SELLERS}/tools/openapi.json`)).text();
  const o = await proposePricing(
    { db: h.db, model: new MockOnboardingModel() },
    { sellerId: "sel_e2e", specText },
  );
  const routes = o.proposals.filter((p) => p.charge);
  await confirmPricing(h.db, {
    sellerId: "sel_e2e",
    aiDecisionId: o.aiDecisionId,
    baseUrl: o.api.baseUrl ?? "",
    routes,
  });
  return o;
}

describe("Text Tools: the demo API that is priced on camera", () => {
  beforeEach(() => h.reset());

  it("is not priced until onboarded, then onboards cleanly next to the live demo API", async () => {
    const before = await h.router(`${SELLERS}/tools/v1/keywords`, post({ text: "hello" }));
    expect(before.status).toBe(500);

    const o = await onboard();
    expect(o.api.baseUrl).toBe(`${SELLERS}/tools`);
    expect(o.proposals.find((p) => p.key === "GET /health")?.charge).toBe(false);

    const live = await h.db
      .select({ method: s.endpoints.method, url: s.endpoints.url })
      .from(s.endpoints)
      .where(and(eq(s.endpoints.active, true), like(s.endpoints.url, `${SELLERS}/tools/%`)));
    expect(live.map((e) => `${e.method} ${e.url}`).sort()).toEqual([
      `POST ${SELLERS}/tools/v1/keywords`,
      `POST ${SELLERS}/tools/v1/translate`,
    ]);

    const agent = await registerAgentKey({
      apiUrl: API,
      buyerApiKey: h.buyerKey,
      agentName: "Claude Code",
      fetch: h.router,
    });
    const c = new Tab402Client({
      keyId: agent.keyId,
      privateKey: agent.privateKey,
      fetch: h.router,
    });
    const kw = await c.fetch(
      `${SELLERS}/tools/v1/keywords`,
      post({ text: "PayPal tabs for agents" }),
    );
    expect(kw.status).toBe(200);
    expect(((await kw.json()) as { keywords: string[] }).keywords.length).toBeGreaterThan(0);
    const tr = await c.fetch(
      `${SELLERS}/tools/v1/translate`,
      post({ text: "Agents pay by the cent.", to: "French" }),
    );
    expect(tr.status).toBe(200);
    expect(await tr.json()).toMatchObject({ to: "French" });
  });

  it("can be onboarded again after the reset script switches its routes off", async () => {
    await onboard();
    await h.db
      .update(s.endpoints)
      .set({ active: false })
      .where(like(s.endpoints.url, `${SELLERS}/tools/%`));
    await expect(onboard()).resolves.toBeDefined();
  });
});
