import { schema as s } from "@tab402/db";
import { and, eq } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { MCP_URL } from "@/lib/mcp";
import { db, requireBuyer } from "@/lib/server";
import { Playground } from "./playground";

export const metadata = { title: "Agent playground" };

export default async function PlaygroundPage() {
  const { buyer } = await requireBuyer("/playground");
  const [policy, endpoints] = await Promise.all([
    db.query.policies.findFirst({ where: (p, { eq }) => eq(p.buyerId, buyer.id) }),
    db
      .select({ url: s.endpoints.url })
      .from(s.endpoints)
      .where(and(eq(s.endpoints.active, true), eq(s.endpoints.method, "POST"))),
  ]);
  // Prefer the runnable demo seller over look-alike routes (e.g. ones added by OpenAPI onboarding).
  const demo = (process.env.DEMO_SELLERS_URL ?? "http://localhost:4200").replace(/\/+$/, "");
  const find = (path: string) =>
    (
      endpoints.find((e) => e.url === `${demo}${path}`) ??
      endpoints.find((e) => e.url.endsWith(path))
    )?.url ?? null;
  return (
    <>
      <PageHeader
        title="Agent playground"
        description="Run the Tab402 MCP tools with buttons. Each call goes to the real MCP server, the same way Claude Code calls it."
      />
      <Playground
        mcpUrl={MCP_URL}
        summarizeUrl={find("/v1/summarize")}
        chatUrl={find("/v1/chat")}
        askFirst={(policy?.approvalThresholdMicros ?? 2_000_000) < 10_000}
      />
    </>
  );
}
