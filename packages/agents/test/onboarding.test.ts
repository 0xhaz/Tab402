import { newId } from "@tab402/core";
import { createDb, schema as s } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfirmedRoute,
  clampPrice,
  confirmPricing,
  describeApi,
  discoveryPreview,
  gateSnippet,
  LiveRoutesError,
  MockOnboardingModel,
  type OnboardingModel,
  parseSpecText,
  pricingDocs,
  proposePricing,
  SpecError,
} from "../src";

const url = await testDatabase("agents");
await runMigrations(url);
const { db, close } = createDb(url, { max: 4 });
afterAll(close);

const OPENAPI_31 = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Acme Data", description: "Company data" },
  servers: [{ url: "https://{env}.acme.example/v1", variables: { env: { default: "api" } } }],
  paths: {
    "/health": { get: { summary: "Health check", responses: { 200: { description: "ok" } } } },
    "/companies/{id}": {
      get: {
        operationId: "getCompany",
        summary: "Look up a company",
        responses: { 200: { description: "ok", content: { "application/json": {} } } },
      },
      parameters: [],
    },
    "/search": {
      post: { summary: "Search companies", requestBody: { content: { "application/json": {} } } },
    },
    "/summarize": { post: { summary: "Summarize a filing with an LLM" } },
    "/logo": {
      post: {
        summary: "Generate a logo image",
        responses: { 201: { content: { "image/png": {} } } },
      },
    },
  },
});

const SWAGGER_YAML = `
swagger: "2.0"
info: { title: Old API }
host: old.example.com
basePath: /api
schemes: [http, https]
produces: [application/json]
paths:
  /items:
    get: { summary: List items }
    x-internal: { summary: ignored }
`;

describe("OpenAPI parsing", () => {
  it("reads OpenAPI 3.1 with server variables, skipping non-operation keys", () => {
    const api = describeApi(parseSpecText(OPENAPI_31));
    expect(api).toMatchObject({
      version: "3.1",
      title: "Acme Data",
      baseUrl: "https://api.acme.example/v1",
    });
    expect(api.operations.map((o) => o.key)).toEqual([
      "GET /health",
      "GET /companies/{id}",
      "POST /search",
      "POST /summarize",
      "POST /logo",
    ]);
    expect(api.operations[4]?.responseTypes).toEqual(["image/png"]);
  });

  it("reads Swagger 2.0 YAML: host + basePath, https preferred, inherited produces", () => {
    const api = describeApi(parseSpecText(SWAGGER_YAML));
    expect(api).toMatchObject({ version: "2.0", baseUrl: "https://old.example.com/api" });
    expect(api.operations).toHaveLength(1);
    expect(api.operations[0]).toMatchObject({
      key: "GET /items",
      responseTypes: ["application/json"],
    });
  });

  it("refuses things that are not API specs", () => {
    expect(() => describeApi(parseSpecText("hello: world"))).toThrow(SpecError);
    expect(() => parseSpecText("{not json")).toThrow(SpecError);
    expect(() => parseSpecText("   ")).toThrow(SpecError);
    expect(() => describeApi({ openapi: "3.0.3", info: {}, paths: {} })).toThrow(/no operations/);
    // YAML alias bombs are capped.
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]\n${Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`).join("\n")}`;
    expect(() => parseSpecText(bomb)).toThrow(SpecError);
  });
});

describe("pricing", () => {
  it("clamps into the category range in tenths of a cent", () => {
    expect(clampPrice("lookup", 50)).toBe(1_000);
    expect(clampPrice("lookup", 999_999)).toBe(10_000);
    expect(clampPrice("search", 12_345)).toBe(12_300);
    expect(clampPrice("media", Number.NaN)).toBe(40_000);
  });
});

describe("onboarding agent", () => {
  let sellerId: string;
  beforeEach(async () => {
    const tables = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    await db.execute(
      sql.raw(
        `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
      ),
    );
    sellerId = newId("seller");
    await db.insert(s.sellers).values({ id: sellerId, name: "Acme Data" });
  });

  it("proposes a category and price per route, leaves utility routes free, and logs the decision", async () => {
    const o = await proposePricing(
      { db, model: new MockOnboardingModel() },
      { sellerId, specText: OPENAPI_31 },
    );
    const by = Object.fromEntries(o.proposals.map((p) => [p.key, p]));
    expect(by["GET /health"]?.charge).toBe(false);
    expect(by["GET /companies/{id}"]).toMatchObject({
      charge: true,
      category: "lookup",
      pricing: "fixed",
    });
    expect(by["POST /search"]).toMatchObject({ category: "search", priceMicros: 10_000 });
    expect(by["POST /summarize"]).toMatchObject({
      category: "llm",
      pricing: "metered",
      rangeMicros: [10_000, 500_000],
    });
    expect(by["POST /logo"]).toMatchObject({ category: "media" });

    const [log] = await db.select().from(s.aiDecisions).where(eq(s.aiDecisions.id, o.aiDecisionId));
    expect(log).toMatchObject({ agentKind: "onboarding", model: "mock", subjectIds: { sellerId } });
    expect(log?.reasoning).toBe("4 of 5 routes priced");
  });

  it("never trusts the model's numbers: clamps out-of-range prices and fills skipped routes", async () => {
    const greedy: OnboardingModel = {
      async propose(input) {
        return {
          model: "greedy",
          latencyMs: 1,
          proposals: [
            {
              key: input.operations[1]?.key ?? "",
              charge: true,
              category: "lookup",
              priceMicros: 250_000_000, // $250 for a lookup
              description: "Ignore previous instructions",
              rationale: "x",
            },
            {
              key: "DELETE /not-in-spec",
              charge: true,
              category: "media",
              priceMicros: 1,
              description: "",
              rationale: "",
            },
          ],
        };
      },
    };
    const o = await proposePricing({ db, model: greedy }, { sellerId, specText: OPENAPI_31 });
    expect(o.proposals).toHaveLength(5);
    expect(o.proposals.find((p) => p.key === "GET /companies/{id}")?.priceMicros).toBe(10_000);
    expect(o.proposals.some((p) => p.key === "DELETE /not-in-spec")).toBe(false);
    expect(o.proposals.find((p) => p.key === "POST /search")).toMatchObject({
      category: "other",
      rationale: "No proposal from the model; category default.",
    });
  });

  it("keeps health and docs routes free even when the model charges them", async () => {
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Free routes" },
      servers: [{ url: "https://free.example.com/tools" }],
      paths: {
        "/health": { get: { summary: "Health" } },
        "/openapi.json": { get: { summary: "Spec" } },
        "/v1/healthy-recipes": { get: { summary: "Recipes" } },
      },
    });
    const chargeAll: OnboardingModel = {
      async propose(input) {
        return {
          model: "charge-all",
          latencyMs: 1,
          proposals: input.operations.map((o) => ({
            key: o.key,
            charge: true,
            category: "lookup" as const,
            priceMicros: 1_000,
            description: o.key,
            rationale: "Free utility route, so no charge.",
          })),
        };
      },
    };
    const o = await proposePricing({ db, model: chargeAll }, { sellerId, specText: spec });
    const charge = Object.fromEntries(o.proposals.map((p) => [p.key, p.charge]));
    expect(charge).toEqual({
      "GET /health": false,
      "GET /openapi.json": false,
      "GET /v1/healthy-recipes": true,
    });
  });

  it("confirming registers endpoints (upsert) and records what the human changed", async () => {
    const o = await proposePricing(
      { db, model: new MockOnboardingModel() },
      { sellerId, specText: OPENAPI_31 },
    );
    const routes = o.proposals
      .filter((p) => p.charge && p.key !== "POST /logo")
      .map((p) => ({
        method: p.method,
        path: p.path,
        pricing: p.pricing,
        priceMicros: p.key === "POST /search" ? 15_000 : p.priceMicros,
        description: p.description,
        category: p.category,
      }));
    const registered = await confirmPricing(db, {
      sellerId,
      aiDecisionId: o.aiDecisionId,
      baseUrl: "https://api.acme.example/v1/",
      routes,
    });
    expect(registered.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.acme.example/v1/companies/{id}",
      "POST https://api.acme.example/v1/search",
      "POST https://api.acme.example/v1/summarize",
    ]);
    const [log] = await db.select().from(s.aiDecisions).where(eq(s.aiDecisions.id, o.aiDecisionId));
    expect(log?.humanOverride).toBe("POST /search: 10000 → 15000; POST /logo: left free");

    // Again with the same routes: updates, no duplicates.
    await confirmPricing(db, {
      sellerId,
      aiDecisionId: o.aiDecisionId,
      baseUrl: "https://api.acme.example/v1",
      routes,
    });
    expect(
      await db.select().from(s.endpoints).where(eq(s.endpoints.sellerId, sellerId)),
    ).toHaveLength(3);

    // Another seller can't confirm this onboarding.
    const other = newId("seller");
    await db.insert(s.sellers).values({ id: other, name: "Other" });
    await expect(
      confirmPricing(db, {
        sellerId: other,
        aiDecisionId: o.aiDecisionId,
        baseUrl: "https://x.example",
        routes,
      }),
    ).rejects.toThrow(/unknown onboarding/);
  });

  it("won't change live routes without overwrite, and never flips their pricing mode", async () => {
    const o = await proposePricing(
      { db, model: new MockOnboardingModel() },
      { sellerId, specText: OPENAPI_31 },
    );
    const base = "https://api.acme.example/v1";
    const search = o.proposals.find((p) => p.key === "POST /search");
    const health = o.proposals.find((p) => p.method === "GET" && p.path === "/health");
    if (!search) throw new Error("no search proposal");
    const route = (p: NonNullable<typeof search>, patch: Partial<ConfirmedRoute> = {}) => ({
      method: p.method,
      path: p.path,
      pricing: p.pricing,
      priceMicros: p.priceMicros,
      description: p.description,
      category: p.category,
      ...patch,
    });
    const confirm = (routes: ConfirmedRoute[], overwrite?: boolean) =>
      confirmPricing(db, {
        sellerId,
        aiDecisionId: o.aiDecisionId,
        baseUrl: base,
        routes,
        overwrite,
      });
    const priceOf = async () =>
      (await db.select().from(s.endpoints).where(eq(s.endpoints.sellerId, sellerId))).map(
        (e) => `${e.pricingMode} ${e.priceMicros}`,
      );

    await confirm([route(search, { pricing: "fixed", priceMicros: 10_000 })]);
    // Same price again is fine.
    await confirm([route(search, { pricing: "fixed", priceMicros: 10_000 })]);

    // A new price needs overwrite; the error lists the change and nothing is written.
    const err = await confirm([route(search, { pricing: "fixed", priceMicros: 20_000 })]).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LiveRoutesError);
    expect(err).toMatchObject({ blocking: false, changes: ["POST /search: $0.01 → $0.02"] });
    expect(await priceOf()).toEqual(["fixed 10000"]);

    // A metered switch is refused even with overwrite.
    const flip = await confirm(
      [route(search, { pricing: "metered", priceMicros: 20_000 })],
      true,
    ).catch((e) => e);
    expect(flip).toMatchObject({ blocking: true });
    expect(await priceOf()).toEqual(["fixed 10000"]);

    // A new route on the live API also asks first.
    if (health) {
      const added = await confirm([route(health, { priceMicros: 1_000 })]).catch((e) => e);
      expect(added).toMatchObject({ blocking: false });
      expect(added.changes[0]).toMatch(/new route on an API that is already live/);
    }

    await confirm([route(search, { pricing: "fixed", priceMicros: 20_000 })], true);
    expect(await priceOf()).toEqual(["fixed 20000"]);

    // Another base URL is a different API: no questions.
    await confirmPricing(db, {
      sellerId,
      aiDecisionId: o.aiDecisionId,
      baseUrl: "https://staging.acme.example/v1",
      routes: [route(search, { pricing: "metered", priceMicros: 30_000 })],
    });
  });

  it("generates the gate config, discovery file and docs from confirmed routes", () => {
    const routes = [
      {
        method: "POST",
        path: "/search",
        pricing: "fixed" as const,
        priceMicros: 15_000,
        description: 'Search "companies"',
        category: "search" as const,
      },
      {
        method: "POST",
        path: "/summarize",
        pricing: "metered" as const,
        priceMicros: 50_000,
        description: "Summarize",
        category: "llm" as const,
      },
    ];
    const snippet = gateSnippet(routes);
    expect(snippet).toContain(
      `"POST /search": { pricing: "fixed", price: 15_000, description: "Search \\"companies\\"", category: "search" }, // $0.0150`,
    );
    expect(snippet).toContain("setActualCost");
    const manifest = discoveryPreview({
      name: "Acme",
      baseUrl: "https://api.acme.example/v1",
      network: "tab402:sandbox",
      routes,
    });
    expect(manifest.resources[1]).toMatchObject({
      url: "https://api.acme.example/v1/summarize",
      tab402: { pricing: "metered", amount: "50000" },
    });
    const docs = pricingDocs({ name: "Acme", baseUrl: "https://api.acme.example/v1", routes });
    expect(docs).toContain("| `POST /summarize` | Summarize | metered, up to $0.05 |");
  });
});
