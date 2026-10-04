import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { API, createHarness, SELLERS, SELLERS2 } from "./harness";

const h = await createHarness();
afterAll(h.close);

const get = (path: string, headers: Record<string, string> = {}) =>
  h.router(`${API}${path}`, { headers });

describe("Tab402 directory", () => {
  let ids: Awaited<ReturnType<typeof h.reset>>;
  beforeEach(async () => {
    ids = await h.reset();
  });

  it("is public and lists every active endpoint of active sellers", async () => {
    const res = await get("/directory");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { data } = (await res.json()) as { data: { url: string; price: string }[] };
    expect(data.map((d) => d.url).sort()).toEqual(
      [
        `${SELLERS}/v1/chat`,
        `${SELLERS}/v1/summarize`,
        `${SELLERS2}/v1/chat`,
        `${SELLERS2}/v1/summarize`,
      ].sort(),
    );
    expect(data.find((d) => d.url === `${SELLERS}/v1/summarize`)?.price).toBe("$0.01");
    expect(data.find((d) => d.url === `${SELLERS}/v1/chat`)?.price).toBe("up to $0.05 (metered)");
  });

  it("ranks by matched words, filters by category and seller, and hides suspended sellers", async () => {
    const first = async (q: string) =>
      (
        (await (await get(`/directory?q=${encodeURIComponent(q)}`)).json()) as {
          data: { url: string }[];
        }
      ).data;
    expect((await first("summarize text"))[0]?.url).toMatch(/\/v1\/summarize$/);
    expect(await first("weather forecast")).toEqual([]);

    const byCat = (await (await get("/directory?category=llm&seller=sel_e2e2")).json()) as {
      data: { sellerId: string }[];
    };
    expect(byCat.data).toHaveLength(2);
    expect(byCat.data.every((d) => d.sellerId === ids.seller2Id)).toBe(true);

    await h.db
      .update(s.sellers)
      .set({ status: "suspended" })
      .where(eq(s.sellers.id, ids.seller2Id));
    const after = (await (await get("/directory")).json()) as { data: { sellerId: string }[] };
    expect(after.data.every((d) => d.sellerId === ids.sellerId)).toBe(true);
    const cats = (await (await get("/directory/categories")).json()) as {
      data: { category: string; endpoints: number }[];
    };
    expect(cats.data).toEqual([{ category: "llm", endpoints: 2 }]);
  });

  it("escapes LIKE wildcards in queries", async () => {
    const res = (await (await get("/directory?q=%25%25")).json()) as { data: unknown[] };
    expect(res.data).toEqual([]);
  });
});

describe("/.well-known/x402 (draft-hawkins-x402-dns-discovery-01)", () => {
  beforeEach(async () => {
    await h.reset();
  });

  it("the seller's API serves a resource-server manifest of its own endpoints, with prices", async () => {
    const res = await h.router(`${SELLERS}/.well-known/x402`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const m = (await res.json()) as {
      x402Version: number;
      kind: string;
      name: string;
      resources: { url: string; method: string; tab402: { amount: string; pricing: string } }[];
    };
    expect(m).toMatchObject({ x402Version: 2, kind: "resource-server", name: "Demo Sellers" });
    // Only this host's endpoints — the draft requires in-domain resource URLs.
    expect(m.resources.map((r) => r.url).sort()).toEqual([
      `${SELLERS}/v1/chat`,
      `${SELLERS}/v1/summarize`,
    ]);
    expect(m.resources.find((r) => r.url.endsWith("/summarize"))).toMatchObject({
      method: "POST",
      tab402: { amount: "10000", pricing: "fixed", network: "tab402:sandbox", asset: "USD" },
    });
  });

  it("the public directory serves the same manifest by seller id; the API serves a facilitator manifest", async () => {
    const bySeller = await get("/directory/sellers/sel_e2e/x402");
    expect(((await bySeller.json()) as { resources: unknown[] }).resources).toHaveLength(2);
    expect((await get("/directory/sellers/sel_nope/x402")).status).toBe(404);

    const f = (await (await get("/.well-known/x402")).json()) as Record<string, unknown>;
    expect(f).toMatchObject({
      x402Version: 2,
      kind: "facilitator",
      facilitator: {
        baseUrl: API,
        endpoints: { supported: "/supported", verify: "/verify", settle: "/settle" },
        kinds: [{ x402Version: 2, scheme: "tab", network: "tab402:sandbox" }],
      },
    });
  });

  it("the seller manifest endpoint needs the seller's key", async () => {
    expect((await get("/seller/x402")).status).toBe(401);
    expect((await get("/seller/x402", { authorization: `Bearer ${h.buyerKey}` })).status).toBe(401);
  });
});
