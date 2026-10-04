/**
 * Talk to the running buyer MCP server like an agent would (pnpm dev first):
 *   npx tsx --env-file=.env scripts/demo/mcp-smoke.ts
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.MCP_URL ?? "http://localhost:4100/mcp";
const key = process.env.DEMO_BUYER_API_KEY;
if (!key) throw new Error("DEMO_BUYER_API_KEY is not set");

const client = new Client({ name: "tab402-smoke", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${key}`, "x-tab402-agent": "smoke-test" } },
  }),
);
const show = (name: string, r: unknown) => {
  const content = (r as { content: { text: string }[]; isError?: boolean }).content;
  console.log(
    `\n▶ ${name}${(r as { isError?: boolean }).isError ? " (error)" : ""}\n${content
      .map((c) => c.text)
      .join("\n")
      .slice(0, 600)}`,
  );
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
show(
  "search_services",
  await client.callTool({ name: "search_services", arguments: { query: "summarize" } }),
);
show(
  "call_paid",
  await client.callTool({
    name: "call_paid",
    arguments: {
      url: "http://localhost:4200/v1/summarize",
      body: { text: "Agents pay per call. Tabs settle through PayPal in batches." },
      intent: "summarize a note for the user",
    },
  }),
);
show("get_budget", await client.callTool({ name: "get_budget", arguments: {} }));
show("list_receipts", await client.callTool({ name: "list_receipts", arguments: { limit: 3 } }));
await client.close();
