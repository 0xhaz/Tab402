"use server";

import { schema as s } from "@tab402/db";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { MCP_URL, type ToolInfo, type ToolRun, withMcp } from "@/lib/mcp";
import { db, requireBuyer } from "@/lib/server";

const agentNameOf = (name: string) => name.trim().slice(0, 64) || "Playground";

function offline(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return /ECONNREFUSED|fetch failed/i.test(msg)
    ? `The MCP server at ${MCP_URL} isn't running. Start the backend with: pnpm turbo run dev --filter='!@tab402/web'`
    : msg;
}

export async function listTools(
  agentName: string,
): Promise<{ ok: true; tools: ToolInfo[] } | { ok: false; error: string }> {
  const { buyer } = await requireBuyer("/playground");
  try {
    const tools = await withMcp(buyer.id, agentNameOf(agentName), async (c) => {
      const { tools } = await c.listTools();
      return tools.map(({ name, title, description }) => ({ name, title, description }));
    });
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, error: offline(e) };
  }
}

export async function callTool(
  agentName: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolRun> {
  const { buyer } = await requireBuyer("/playground");
  const started = Date.now();
  try {
    const result = (await withMcp(buyer.id, agentNameOf(agentName), (c) =>
      c.callTool({ name: tool, arguments: args }),
    )) as { content?: { type: string; text?: string }[]; isError?: boolean };
    return {
      tool,
      args,
      text: (result.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n"),
      isError: Boolean(result.isError),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { tool, args, text: offline(e), isError: true, ms: Date.now() - started };
  }
}

/** Demo switch: "ask me first" drops the approval threshold below a one-cent call; off restores $2. */
export async function setAskFirst(on: boolean) {
  const { buyer } = await requireBuyer("/playground");
  await db.insert(s.policies).values({ buyerId: buyer.id }).onConflictDoNothing();
  await db
    .update(s.policies)
    .set({
      approvalThresholdMicros: on ? 5_000 : 2_000_000,
      version: sql`${s.policies.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(s.policies.buyerId, buyer.id));
  revalidatePath("/playground");
  revalidatePath("/policy");
}
