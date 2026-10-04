/**
 * Postman collection (v2.1) from the API's OpenAPI spec, plus an ordered "Walkthrough" folder:
 * buyer wallet setup → seller registers a route → unpaid call gets 402 → directory and discovery →
 * events after settlement. Signing vouchers needs ES256 + canonical JSON, which Postman's sandbox
 * can't do — the paid call itself is made with the SDK (scripts/demo/pay.ts) or the MCP server.
 *   npx tsx scripts/postman/build.ts   → docs/postman/*.json
 */
import { writeFile } from "node:fs/promises";
import { createApp } from "@tab402/api/app";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  $ref?: string;
};
type Operation = {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

// Only the spec is generated; no handler runs, so the dependencies are never touched.
const app = createApp({} as Parameters<typeof createApp>[0]);
const spec = (await (await app.request("/openapi.json")).json()) as Spec;

const resolve = (s: Schema | undefined): Schema | undefined =>
  s?.$ref ? spec.components?.schemas?.[s.$ref.split("/").pop() ?? ""] : s;

/** A small example value from a JSON schema: example → default → enum → by type. */
function sample(s0: Schema | undefined, depth = 0): unknown {
  const s = resolve(s0);
  if (!s || depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  if (alt) return sample(alt, depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "object" || s.properties)
    return Object.fromEntries(
      Object.entries(s.properties ?? {})
        .filter(([k]) => !s.required || s.required.includes(k))
        .map(([k, v]) => [k, sample(v, depth + 1)]),
    );
  if (type === "array") return [sample(s.items, depth + 1)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (s.format === "email") return "seller@example.com";
  if (s.format === "uri" || s.format === "url") return "https://example.com";
  return "string";
}

/** Which key a route takes: seller routes and buyer routes are tagged in the spec. */
const keyFor = (op: Operation) =>
  !op.security?.length
    ? null
    : op.tags?.some((t) => t === "Buyers" || t === "Spend guard")
      ? "{{buyerKey}}"
      : "{{sellerKey}}";

const request = (method: string, path: string, op: Operation) => {
  const body = op.requestBody?.content?.["application/json"]?.schema;
  const query = (op.parameters ?? []).filter((p) => p.in === "query");
  const raw = `{{baseUrl}}${path.replace(/\{(\w+)\}/g, ":$1")}`;
  const key = keyFor(op);
  return {
    name: op.summary ?? `${method.toUpperCase()} ${path}`,
    request: {
      method: method.toUpperCase(),
      description: op.description,
      header: body ? [{ key: "Content-Type", value: "application/json" }] : [],
      ...(key
        ? { auth: { type: "bearer", bearer: [{ key: "token", value: key, type: "string" }] } }
        : { auth: { type: "noauth" } }),
      url: {
        raw,
        host: ["{{baseUrl}}"],
        path: path
          .split("/")
          .filter(Boolean)
          .map((seg) => seg.replace(/^\{(\w+)\}$/, ":$1")),
        ...(query.length
          ? {
              query: query.map((q) => ({
                key: q.name,
                value: String(sample(q.schema) ?? ""),
                disabled: !q.required,
              })),
            }
          : {}),
        variable: (op.parameters ?? [])
          .filter((p) => p.in === "path")
          .map((p) => ({ key: p.name, value: `{{${p.name}}}` })),
      },
      ...(body
        ? {
            body: {
              mode: "raw",
              raw: JSON.stringify(sample(body), null, 2),
              options: { raw: { language: "json" } },
            },
          }
        : {}),
    },
  };
};

const byTag = new Map<string, ReturnType<typeof request>[]>();
for (const [path, ops] of Object.entries(spec.paths))
  for (const [method, op] of Object.entries(ops)) {
    const tag = op.tags?.[0] ?? "Other";
    byTag.set(tag, [...(byTag.get(tag) ?? []), request(method, path, op)]);
  }

const json = (raw: unknown) => ({
  mode: "raw",
  raw: JSON.stringify(raw, null, 2),
  options: { raw: { language: "json" } },
});
const bearer = (v: string) => ({
  type: "bearer",
  bearer: [{ key: "token", value: v, type: "string" }],
});
const test = (lines: string[]) => [
  { listen: "test", script: { type: "text/javascript", exec: lines } },
];

const walkthrough = {
  name: "Walkthrough: wallet → 402 → paid → settled",
  description:
    "Run in order. The paid call (step 5) needs an ES256-signed voucher, which Postman's sandbox can't produce: run `npx tsx --env-file=.env scripts/demo/pay.ts` or ask Claude through the Tab402 MCP server, then continue with step 6.",
  item: [
    {
      name: "1. Facilitator: supported schemes",
      request: { method: "GET", auth: { type: "noauth" }, url: "{{baseUrl}}/supported" },
      event: test([
        "pm.test('tab scheme', () => pm.expect(pm.response.json().kinds[0].scheme).to.eql('tab'));",
      ]),
    },
    {
      name: "2. Buyer: start PayPal wallet setup (vault without purchase)",
      request: {
        method: "POST",
        auth: bearer("{{buyerKey}}"),
        header: [{ key: "Content-Type", value: "application/json" }],
        url: "{{baseUrl}}/wallet/setup",
        body: json({ returnUrl: "{{webUrl}}/wallet", cancelUrl: "{{webUrl}}/wallet" }),
        description:
          "Open the returned approval URL in a browser and approve with a PayPal sandbox buyer.",
      },
    },
    {
      name: "3. Seller: register a priced route",
      request: {
        method: "PUT",
        auth: bearer("{{sellerKey}}"),
        header: [{ key: "Content-Type", value: "application/json" }],
        url: "{{baseUrl}}/endpoints",
        body: json({
          endpoints: [
            {
              method: "POST",
              url: "{{sellerUrl}}/v1/summarize",
              pricing: "fixed",
              price: "10000",
              description: "Summarize text",
              category: "llm",
            },
          ],
        }),
      },
    },
    {
      name: "4. Agent: call without paying → 402 + PAYMENT-REQUIRED",
      request: {
        method: "POST",
        auth: { type: "noauth" },
        header: [{ key: "Content-Type", value: "application/json" }],
        url: "{{sellerUrl}}/v1/summarize",
        body: json({ text: "Tab402 lets agents pay per call." }),
      },
      event: test([
        "pm.test('402 Payment Required', () => pm.response.to.have.status(402));",
        "const required = JSON.parse(atob(pm.response.headers.get('PAYMENT-REQUIRED')));",
        "pm.test('tab scheme offered', () => pm.expect(required.accepts.map(a => a.scheme)).to.include('tab'));",
        "console.log('PAYMENT-REQUIRED', required);",
      ]),
    },
    {
      name: "5. (SDK) Pay and call — see folder description",
      request: {
        method: "GET",
        auth: { type: "noauth" },
        url: "{{baseUrl}}/health",
        description: "Placeholder: run scripts/demo/pay.ts.",
      },
    },
    {
      name: "6. Directory: find the route",
      request: {
        method: "GET",
        auth: { type: "noauth" },
        url: "{{baseUrl}}/directory?q=summarize",
      },
    },
    {
      name: "7. Discovery: the seller's /.well-known/x402",
      request: { method: "GET", auth: { type: "noauth" }, url: "{{sellerUrl}}/.well-known/x402" },
    },
    {
      name: "8. Seller: events (charge, settlement, payout)",
      request: { method: "GET", auth: bearer("{{sellerKey}}"), url: "{{baseUrl}}/events?limit=50" },
      event: test([
        "pm.test('ok', () => pm.response.to.have.status(200));",
        "console.log(pm.response.json().data.map(e => e.type));",
      ]),
    },
  ],
};

const collection = {
  info: {
    name: "Tab402 API",
    description:
      "x402 facilitator for fiat tabs, seller and buyer APIs. Generated from /openapi.json by scripts/postman/build.ts — do not edit by hand.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    walkthrough,
    ...[...byTag].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, item })),
  ],
  variable: [{ key: "baseUrl", value: "http://localhost:4000" }],
};

const environment = {
  name: "Tab402 local",
  values: [
    { key: "baseUrl", value: "http://localhost:4000", enabled: true },
    { key: "sellerUrl", value: "http://localhost:4200", enabled: true },
    { key: "webUrl", value: "http://localhost:3000", enabled: true },
    { key: "sellerKey", value: "", type: "secret", enabled: true },
    { key: "buyerKey", value: "", type: "secret", enabled: true },
  ],
};

const out = new URL("../../docs/postman/", import.meta.url);
await writeFile(
  new URL("tab402.postman_collection.json", out),
  `${JSON.stringify(collection, null, 2)}\n`,
);
await writeFile(
  new URL("tab402-local.postman_environment.json", out),
  `${JSON.stringify(environment, null, 2)}\n`,
);
const count = [...byTag.values()].reduce((n, v) => n + v.length, 0);
console.log(
  `docs/postman: ${count} API requests in ${byTag.size} folders + ${walkthrough.item.length}-step walkthrough`,
);
