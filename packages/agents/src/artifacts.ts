import { type ResourceServerManifest, resourceServerManifest } from "@tab402/core";
import type { ConfirmedRoute } from "./onboarding";

const usd = (micros: number) => `$${(micros / 1e6).toFixed(micros % 10_000 ? 4 : 2)}`;

/** The `routes` block for `tab402Gate` (Hono), ready to paste. */
export function gateSnippet(routes: ConfirmedRoute[]): string {
  const lines = routes.map(
    (r) =>
      `    ${JSON.stringify(`${r.method.toUpperCase()} ${r.path}`)}: { pricing: ${JSON.stringify(r.pricing)}, price: ${r.priceMicros.toLocaleString("en-US").replaceAll(",", "_")}, description: ${JSON.stringify(r.description)}, category: ${JSON.stringify(r.category)} }, // ${r.pricing === "metered" ? "up to " : ""}${usd(r.priceMicros)}`,
  );
  return `import { tab402Discovery, tab402Gate } from "@tab402/sdk-server";

const tab402 = {
  facilitatorUrl: process.env.TAB402_API_URL!,
  apiKey: process.env.TAB402_SELLER_KEY!, // t402_sk_…
  baseUrl: process.env.PUBLIC_URL!,
};

app.use(
  "*",
  tab402Gate({
    ...tab402,
    // Prices in micro-USD (1_000_000 = $1). Routes not listed stay free.
    routes: {
${lines.join("\n")}
    },
  }),
);
app.get("/.well-known/x402", tab402Discovery(tab402));
${
  routes.some((r) => r.pricing === "metered")
    ? `
// Metered routes must report their cost before responding:
//   c.var.tab402.setActualCost(providerCostMicros * 1.3)
`
    : ""
}`;
}

/** The /.well-known/x402 file the gate will serve, as a preview. */
export function discoveryPreview(input: {
  name: string;
  baseUrl: string;
  network: string;
  routes: ConfirmedRoute[];
}): ResourceServerManifest {
  const base = input.baseUrl.replace(/\/+$/, "");
  return resourceServerManifest({
    name: input.name,
    network: input.network,
    endpoints: input.routes.map((r) => ({
      url: `${base}${r.path}`,
      method: r.method.toUpperCase(),
      description: r.description,
      category: r.category,
      pricing: r.pricing,
      priceMicros: r.priceMicros,
    })),
  });
}

/** Buyer-facing docs for the priced routes (Markdown). */
export function pricingDocs(input: {
  name: string;
  baseUrl: string;
  routes: ConfirmedRoute[];
}): string {
  const base = input.baseUrl.replace(/\/+$/, "");
  const rows = input.routes
    .map(
      (r) =>
        `| \`${r.method.toUpperCase()} ${r.path}\` | ${r.description.replaceAll("|", "\\|")} | ${r.pricing === "metered" ? `metered, up to ${usd(r.priceMicros)}` : usd(r.priceMicros)} |`,
    )
    .join("\n");
  return `# ${input.name} — pay per call

These routes answer \`402 Payment Required\` with an x402 quote. Agents with a Tab402 wallet pay automatically; you get one PayPal charge for the whole tab.

| Route | What it does | Price per call |
|---|---|---|
${rows}

**From an agent:** add the Tab402 MCP server and ask for what you need — \`search_services\` finds these routes and \`call_paid\` pays for them within your budget.

**From code:**

\`\`\`ts
import { Tab402Client } from "@tab402/sdk-client";
const res = await client.fetch("${base}${input.routes[0]?.path ?? "/"}", { method: "${input.routes[0]?.method.toUpperCase() ?? "GET"}" }, { intent: "why you are calling" });
\`\`\`

Discovery: \`${base}/.well-known/x402\`.
`;
}
